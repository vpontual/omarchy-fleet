import QtQuick
import QtQml
import Quickshell
import Quickshell.Io
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
  // One row per configured server, in address order. Republished only when
  // something a row renders has changed.
  property var nodes: []
  property bool probing: false

  readonly property var fleet: Model.fleetState(nodes)
  readonly property bool busy: fleet.busy
  // True only once every node has produced two readings, so the UI can say
  // "measuring" instead of asserting an idle fleet it has not yet observed.
  //
  // Derived rather than assigned: it is a pure function of the rows, and as an
  // imperative flag the only place it could be recomputed was the publish
  // path -- so it was one more thing that had to be remembered there.
  readonly property bool baselineReady: Model.baselineReady(nodes)

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 3, 1, 60)
  readonly property string serversSetting: stringSetting("servers", "")

  // host -> { host, port, runtime, sample, lastSeenMs }
  property var _state: ({})
  // host -> the last row built for it. The table is assembled from this, so
  // one host's slow probe cannot hold up another host's result.
  property var _rows: ({})
  // What was last published, so an unchanged fleet is not republished.
  property string _signature: ""

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
    _state = ({})
    _rows = ({})
    _signature = ""
    refresh()
  }

  // Poll every configured host that is not already being polled.
  //
  // PER HOST, not per fleet, and that is the whole shape of this file. It used
  // to run fleet-wide cycles: one counter of outstanding probes, nothing
  // published until it reached zero, and an early return while any of it was
  // in flight. So the slowest host set the period for every other host, and
  // the user's refresh interval was silently unachievable -- measured at
  // 16 seconds against a configured 3 because ONE address in the fleet was
  // unreachable, and a full discovery sweep makes that 33. Activity here is a
  // counter delta, so that interval is not just display lag: it is the window
  // the delta is taken over, and this widget exists to answer "is it working
  // RIGHT NOW".
  //
  // A host already in flight is skipped rather than stacked, which is what the
  // fleet-wide fence was really for.
  function refresh() {
    var servers = configuredServers()
    // Nothing configured: publish an empty fleet ONCE rather than reassigning
    // an empty array every tick, which re-evaluated every binding downstream
    // for no reason.
    if (servers.length === 0) {
      _state = ({})
      _rows = ({})
      if (nodes.length > 0) { nodes = []; _signature = "" }
      return
    }

    var hosts = configuredHosts()
    _state = Model.pruneToConfigured(_state, hosts)
    _rows = Model.pruneToConfigured(_rows, hosts)

    for (var i = 0; i < servers.length; i++) _poll(servers[i].host, i)
    probing = _anyRunning()
    _publish()
  }

  // One process per host, addressed by the host's index in the configured
  // list. Quickshell's Process is single-shot, so the pool is created
  // declaratively by the Instantiator below.
  function _poll(host, index) {
    var proc = probePool.objectAt(index)
    // No slot for this host at all: account for it rather than leaving the row
    // silently un-updated.
    if (!proc) { _record(host, null); return }

    var action = Model.pollAction(proc, Date.now())
    if (action === "skip") return
    if (action === "kill") {
      // `timeout --signal=KILL` inside the command bounds every normal case,
      // so reaching here means the process itself failed to exit.
      _log("killing a probe on " + proc.host + " that overran its deadline")
      proc.abandoned = true
      proc.running = false
      _record(host, null)
      return
    }

    var known = _state[host]
    // The deadline comes from the script, not from a constant sitting beside
    // it: a discovery sweep can spend five times what a known-node read can,
    // and the two disagreed badly enough that no host was discoverable unless
    // it answered on the first candidate port.
    var budget = Probe.budgetSec(Model, host, known)
    proc.host = host
    proc.deadlineMs = Date.now() + (budget + 2) * 1000
    // `timeout` wraps BASH, not curl: GNU timeout runs its command in its own
    // process group and signals that group, so the bound covers the whole
    // sweep rather than one request inside it. `env -u` because
    // non-interactive `bash -c` sources $BASH_ENV before running its script --
    // not a privilege boundary, since anything that can set it already runs as
    // this user, but this wrapper should not be a way into a shell it did not
    // intend to start.
    proc.command = ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV",
                    "/usr/bin/timeout", "--signal=KILL", String(budget),
                    "/usr/bin/bash", "-c", Probe.script(Model, host, known)]
    proc.running = true
  }

  function _anyRunning() {
    for (var i = 0; i < probePool.count; i++) {
      var p = probePool.objectAt(i)
      if (p && p.running) return true
    }
    return false
  }

  // ── Result assembly ─────────────────────────────────────────────────

  function _record(host, out) {
    // Everything a reading is allowed to claim is decided in Reading.js,
    // which is plain JS: its branches are executed by tests rather than
    // matched against QML source text.
    var res = Reading.apply(Model, Probe, host, labelFor(host),
                            out, _state[host], Date.now())
    if (res.state) _state[host] = res.state
    _rows[host] = res.node
    probing = _anyRunning()
    _publish()
  }

  // Assemble the table from whatever each host has last said.
  function _publish() {
    var out = Model.tableRows(configuredServers(), _rows, _state)
    // Assigning a fresh array re-runs every binding downstream, and a JS
    // array model has no diffing -- so every NodeRow (a CursorSurface and
    // five Texts) is destroyed and rebuilt, twenty times a minute, in the
    // process that draws the whole desktop. A quiet fleet produces the same
    // rows over and over, so most polls have nothing to publish.
    var next = Model.signature(out)
    if (next === _signature) return
    _signature = next
    nodes = out
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
      // When this probe may still legitimately be working.
      property real deadlineMs: 0
      // Killed for overrunning: whatever it eventually prints is not a
      // reading, and the slot stays out of service until it actually dies.
      property bool abandoned: false
      running: false
      command: []
      stdout: StdioCollector { id: collector; waitForEnd: true }
      onExited: function (exitCode) {
        if (abandoned) {
          abandoned = false
          root.probing = root._anyRunning()
          return
        }
        root._record(host, collector.text)
      }
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
}
