import QtQuick
import QtQml
import Quickshell
import Quickshell.Io
import "lib/Fleet.js" as Fleet
import "lib/Poll.js" as Poll
import "lib/Probe.js" as Probe
import "lib/Reading.js" as Reading
import "lib/Servers.js" as Servers
import "lib/Text.js" as Text

// Fleet activity for the bar widget.
//
// Two constraints set the shape of this file.
//
// A vLLM /metrics body is ~68 kB and this runs inside the process that draws
// the whole desktop, so the payload is filtered by `grep` at the fetch
// boundary and the shell sees a few hundred bytes per node.
//
// Activity is a COUNTER DELTA, so every node needs a previous sample to
// compare against. The first poll can never report activity -- it establishes
// the baseline -- which is why nodes begin as "measuring", not as idle.
Item {
  id: root

  property var settings: ({})
  property QtObject bar: null

  // ── Observed state ──────────────────────────────────────────────────
  // One row per configured server, in address order. Republished only when
  // something a row renders has changed.
  property var nodes: []
  property bool probing: false

  readonly property var fleet: Fleet.fleetState(nodes)
  readonly property bool busy: fleet.busy
  // True only once every node has produced two readings, so the UI can say
  // "measuring" rather than assert an idle fleet it has not observed. Derived,
  // not assigned: as a flag it could only be recomputed in the publish path.
  readonly property bool baselineReady: Fleet.baselineReady(nodes)

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
  //
  // Parsed ONCE per settings change, not once per node per poll.
  //
  // This used to re-parse and re-regex the whole `servers` string on every
  // call, and it is called from a binding (`Instantiator.model`) and from
  readonly property var configured: {
    var parsed = Servers.parseServers(serversSetting)
    var out = [], rejected = [], seen = {}
    for (var i = 0; i < parsed.length; i++) {
      var h = parsed[i].host.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
      if (h === "") continue
      if (!Servers.isSafeHost(h)) { rejected.push(h); continue }
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
      + Text.clampField(configured.rejected.join(", "))

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
      out.push(Fleet.nodeSummary(n))
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
  // Without this a misdetection is permanent for the life of the shell: start
  // llama-server WITHOUT --metrics and it is found on /v1/models as `openai`
  // and cached, and restarting it WITH --metrics does not help.
  function rediscover() {
    _state = ({})
    _rows = ({})
    _signature = ""
    refresh()
  }

  // Poll every configured host that is not already being polled.
  //
  // PER HOST, not per fleet, and that is the whole shape of this file. Run as
  // fleet-wide cycles -- nothing published until every probe returned -- the
  // slowest host sets the period for all of them and the configured interval
  // becomes unachievable: 16 seconds against a configured 3, from one
  // unreachable address. Activity is a counter delta, so that interval is also
  // the window the delta covers, and this widget answers "right NOW".
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
    _state = Poll.pruneToConfigured(_state, hosts)
    _rows = Poll.pruneToConfigured(_rows, hosts)

    for (var i = 0; i < servers.length; i++) _poll(servers[i].host, i)
    probing = _anyRunning()
    _publish()
  }

  // One process per host, addressed by the host's index in the configured
  // list. Quickshell's Process is single-shot, so the pool is created
  // declaratively by the Instantiator below.
  function _poll(host, index) {
    var proc = probePool.objectAt(index)
    // No slot for this host at all: nothing was asked, so nothing is known.
    if (!proc) { _forget(host); return }

    var action = Poll.pollAction(proc, Date.now())
    if (action === "skip") return
    if (action === "kill") {
      // `timeout --signal=KILL` inside the command bounds every normal case,
      // so reaching here means the process itself failed to exit.
      _log("killing a probe on " + proc.host + " that overran its deadline")
      proc.abandoned = true
      // Setting running = false sends SIGTERM. It is `timeout --signal=KILL`
      // inside the command that guarantees the process actually dies -- a child
      // trapping TERM would otherwise stay running, `abandoned` would stay true,
      // and pollAction would skip this host forever.
      proc.running = false
      _forget(host)
      return
    }

    var known = _state[host]
    // The deadline comes from the script, not from a constant sitting beside
    // it: a discovery sweep can spend five times what a known-node read can,
    // and the two disagreed badly enough that no host was discoverable unless
    // it answered on the first candidate port.
    var budget = Probe.budgetSec(host, known)
    proc.host = host
    proc.deadlineMs = Date.now() + (budget + 2) * 1000
    // `timeout` wraps BASH, not curl: it signals the whole process group, so
    // the bound covers the entire sweep rather than one request inside it.
    // `env -u` because non-interactive `bash -c` sources $BASH_ENV first --
    // not a privilege boundary, but not a door this wrapper should open.
    proc.command = ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV",
                    "/usr/bin/timeout", "--signal=KILL", String(budget),
                    "/usr/bin/bash", "-c", Probe.script(host, known)]
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

  // We learned nothing: our own probe failed, or there was no slot to run it
  // in. Reset the row to the un-probed one rather than record a failed reading
  // -- "unreachable" is a claim about the SERVER, and these are facts about us.
  function _forget(host) {
    _rows[host] = Fleet.blankNode(host, labelFor(host), _state[host])
    probing = _anyRunning()
    _publish()
  }

  function _record(host, out) {
    // Everything a reading is allowed to claim is decided in Reading.js,
    // which is plain JS: its branches are executed by tests rather than
    // matched against QML source text.
    var res = Reading.apply(host, labelFor(host),
                            out, _state[host], Date.now())
    // An absent state means "forget what was cached" -- which is what clears a
    // runtime whose adapter no longer exists, so discovery can start over.
    if (res.state) _state[host] = res.state
    else delete _state[host]
    _rows[host] = res.node
    probing = _anyRunning()
    _publish()
  }

  // Assemble the table from whatever each host has last said.
  function _publish() {
    var out = Poll.tableRows(configuredServers(), _rows, _state)
    // A JS array model has no diffing, so assigning a fresh one destroys and
    // rebuilds every NodeRow -- a CursorSurface and five Texts each -- twenty
    // times a minute in the process that draws the desktop. A quiet fleet
    // produces identical rows, so most polls have nothing to publish.
    var next = Fleet.signature(out)
    if (next === _signature) return
    _signature = next
    nodes = out
  }

  // A pool of Process objects, one per configured server, addressed by index.
  //
  // Instantiator, NOT Repeater: a Repeater can only create Items and a Process
  // is a plain QtObject, so a Repeater silently produces nothing -- itemAt()
  // returns null for every host and the whole fleet reads unreachable.
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
