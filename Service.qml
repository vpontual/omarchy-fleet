import QtQuick
import QtQml
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model
import "Probe.js" as Probe
import "Reading.js" as Reading

// Fleet activity for the bar widget.
//
// The shape of this file is set by two constraints.
//
// One: a vLLM /metrics body is ~68 kB, and this runs inside the process that
// hosts the whole desktop. So the payload is filtered by `grep` at the fetch
// boundary and the shell only ever sees a few hundred bytes per node.
//
// Two: activity is a COUNTER DELTA, so every node needs a previous sample to
// compare against. The first poll after a start can therefore never report
// activity -- it establishes the baseline. That is why nodes begin as
// "waiting for a second reading" rather than as idle.
Item {
  id: root

  property var settings: ({})
  property QtObject bar: null

  // ── Observed state ──────────────────────────────────────────────────
  // One entry per configured server. Rebuilt wholesale on each cycle.
  property var nodes: []
  property bool probing: false

  readonly property var fleet: Model.fleetState(nodes)
  readonly property bool busy: fleet.busy
  // True only once every node has produced two readings, so the UI can say
  // "measuring" instead of asserting an idle fleet it has not yet observed.
  property bool baselineReady: false

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 3, 1, 60)
  readonly property string serversSetting: stringSetting("servers", "")

  // host -> { host, port, runtime, sample, lastSeenMs }
  property var _state: ({})
  property int _pending: 0
  // Incremented per refresh; a result carrying an older id is discarded.
  property int _cycle: 0
  property var _collected: []

  function setting(name, fallback) {
    var v = settings ? settings[name] : undefined
    return v === undefined || v === null ? fallback : v
  }
  function intSetting(name, fallback, min, max) {
    var v = Number(setting(name, fallback))
    if (!isFinite(v)) return fallback
    return Math.max(min, Math.min(max, Math.round(v)))
  }
  function stringSetting(name, fallback) {
    var v = setting(name, fallback)
    return typeof v === "string" ? v : fallback
  }

  // Comma or whitespace separated, so "a, b" and "a b" both work. Anything
  // that is not a plain host[:port] is dropped rather than passed to a shell.
  // Parsed ONCE per settings change, not once per node per cycle.
  //
  // This used to re-parse and re-regex the whole `servers` string on every
  // call, and it is called from a binding (`Instantiator.model`) and from
  readonly property var configured: {
    var parsed = Model.parseServers(serversSetting)
    var out = [], rejected = [], seen = {}
    for (var i = 0; i < parsed.length; i++) {
      var h = parsed[i].host.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
      if (h === "") continue
      if (!Model.isSafeHost(h)) { rejected.push(h); continue }
      // First mention wins. Two entries for one host share a single _state
      // key, so the second result of each cycle overwrote the first's sample
      // and the activity delta was measured against the wrong reading -- the
      // node reported work it had not done, or missed work it had.
      if (seen[h]) continue
      seen[h] = true
      out.push({ host: h, label: parsed[i].label })
    }
    return { servers: out, rejected: rejected }
  }

  function configuredServers() { return configured.servers }

  // Surfaced where a person will see it, not only in diagnostics: a typo used
  // to drop the server silently, with nothing in the panel to say so.
  readonly property string configError: configured.rejected.length === 0 ? ""
    : "Ignoring " + (configured.rejected.length === 1 ? "an unusable address: "
                                                      : configured.rejected.length + " unusable addresses: ")
      + Model.clampField(configured.rejected.join(", "))

  function configuredHosts() {
    var servers = configuredServers()
    var out = []
    for (var i = 0; i < servers.length; i++) out.push(servers[i].host)
    return out
  }

  // The nickname for a host, or "" when it was not named.
  function labelFor(host) {
    var servers = configured.servers
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].host === host) return servers[i].label
    }
    return ""
  }

  function _log(message) { console.warn("fleet: " + message) }

  // One call carrying everything needed to explain a problem, for
  // `qs -p /usr/share/omarchy/shell ipc call veepee.fleet diagnostics`.
  function diagnosticsJson() {
    var out = []
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      out.push(Model.nodeSummary(n))
    }
    return JSON.stringify({
      plugin: "veepee.fleet",
      configured: configuredServers(),
      refreshIntervalSec: refreshIntervalSec,
      baselineReady: baselineReady,
      fleet: fleet,
      rejected: configured.rejected,
      nodes: out
    }, null, 2)
  }

  // ── Polling ─────────────────────────────────────────────────────────

  // Forget what was detected, so the next poll re-discovers from scratch.
  //
  // A misdetection was otherwise permanent for the life of the shell: start
  // llama-server WITHOUT --metrics and it is found on /v1/models as `openai`,
  // cached, and reads "no activity signal" forever -- restarting llama.cpp
  // with --metrics does not help, only restarting omarchy-shell does. The
  // manual refresh is the natural place to offer that.
  function rediscover() {
    _state = {}
    refresh()
  }

  function refresh() {
    if (probing) return
    var servers = configuredServers()
    // Nothing configured: publish an empty fleet ONCE rather than reassigning
    // an empty array every tick, which re-evaluated every binding downstream
    // for no reason.
    if (servers.length === 0) {
      if (nodes.length > 0) nodes = []
      return
    }

    // Every cycle carries an id, and _finish drops anything that does not
    // belong to the current one. The watchdog resets `probing` without killing
    // the processes, so a straggler from an abandoned cycle used to decrement
    // the NEW cycle's _pending -- publishing a partial list early, then driving
    // _pending negative and re-publishing on each further straggler. Servers
    // flickered in and out of the panel with nothing to say why.
    _cycle++
    probing = true
    probeWatchdog.restart()
    _collected = []
    _pending = servers.length
    for (var i = 0; i < servers.length; i++) probeHost(servers[i].host, i, _cycle)
  }

  // One process per host. Quickshell's Process is a single-shot object, so a
  // pool is created declaratively by the Instantiator below, addressed by index.
  function probeHost(host, index, cycle) {
    var known = _state[host]
    var proc = probePool.objectAt(index)
    if (!proc) { _finish(host, null); return }

    // A straggler the watchdog abandoned may still be alive on this slot. The
    // fence stamps the process, not the result, so re-stamping it would credit
    // its stale output to THIS cycle -- and `running = true` on an already
    // running Process does nothing, so the host would be silently skipped.
    // Kill it (its exit lands under the old id and is discarded) and report
    // the host as unreachable for this cycle rather than inventing a reading.
    if (proc.running) {
      _log("killing a straggler on " + proc.host + " from cycle " + proc.cycle)
      proc.running = false
      _finish(host, null, cycle)
      return
    }

    proc.host = host
    proc.cycle = cycle
    // `timeout` wraps BASH, not curl: GNU timeout runs its command in its own
    // process group and signals that group, so the bound covers the whole
    // sweep rather than one request inside it. `env -u` because
    // non-interactive `bash -c` sources $BASH_ENV before running its script --
    // not a privilege boundary, since anything that can set it already runs as
    // this user, but this wrapper should not be a way into a shell it did not
    // intend to start.
    proc.command = ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV",
                    "/usr/bin/timeout", "--signal=KILL", String(Model.PROBE_TIMEOUT_SEC),
                    "/usr/bin/bash", "-c", Probe.script(Model, host, known)]
    proc.running = true
  }

  // Built from a fixed template; `host` has already passed isSafeHost, and
  // nothing else in the string is user-derived.
  //
  // When the runtime is not yet known the script sweeps the candidate ports
  // and prints the first that answers, tagged so the reply identifies both the
  // port and the body. A refused port answers in about 45ms.


  // ── Result assembly ─────────────────────────────────────────────────

  function _finish(host, out, cycle) {
    // A result from a cycle the watchdog gave up on is not evidence about this
    // one. Its process was never killed, only forgotten.
    if (cycle !== undefined && cycle !== _cycle) {
      _log("discarding a late result for " + host + " from cycle " + cycle)
      return
    }
    // Everything a reading is allowed to claim is decided in Reading.js,
    // which is plain JS: its branches are executed by tests rather than
    // matched against QML source text.
    var res = Reading.apply(Model, Probe, host, labelFor(host),
                            out, _state[host], Date.now())
    if (res.state) _state[host] = res.state
    var node = res.node

    _collected.push(node)
    _pending--
    if (_pending <= 0) {
      _collected.sort(function (a, b) { return a.host < b.host ? -1 : 1 })
      nodes = _collected
      probing = false
      probeWatchdog.stop()
      var ready = nodes.length > 0
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].reachable && nodes[i].firstReading) ready = false
      }
      baselineReady = ready
    }
  }

  // A pool of Process objects, one per configured server, addressed by index.
  //
  // Instantiator, NOT Repeater: a Repeater can only create Items and a Process
  // is a plain QtObject, so it silently produced nothing -- itemAt() returned
  // null for every host and the whole fleet reported unreachable. The shell
  // logged "Delegate must be of Item type"; nothing surfaced in the widget.
  // The shell itself uses Instantiator for the same reason.
  Instantiator {
    id: probePool
    model: root.configuredHosts().length
    delegate: Process {
      required property int index
      property string host: ""
      property int cycle: 0
      running: false
      command: []
      stdout: StdioCollector { id: collector; waitForEnd: true }
      onExited: function (exitCode) { root._finish(host, collector.text, cycle) }
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // A probe that never returns would stall the cycle forever, since refresh()
  // returns early while `probing` is true. curl carries --max-time, so this is
  // the backstop for the process itself failing to exit.
  Timer {
    id: probeWatchdog
    interval: 15000
    // Restarted by refresh(), so this is a deadline for THIS cycle rather than
    // a clock. Free-running, it fired at t=15, 30, 45... regardless of when a
    // cycle began -- so a cycle starting at 14.9s was abandoned 100ms in, and
    // the panel could sit stale for up to two intervals while it recovered.
    repeat: false
    running: false
    onTriggered: {
      if (!root.probing) return
      root._log("probe cycle did not finish within 15s; resetting")
      // Bump the id so anything still running is fenced out when it lands.
      root._cycle++
      root.probing = false
      root._pending = 0
    }
  }
}
