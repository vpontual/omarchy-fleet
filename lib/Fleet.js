.pragma library
.import "Runtimes.js" as Runtimes

// What a row, a fleet and the bar icon are allowed to CLAIM.
//
// This is the honesty layer, and it is the part of the plugin that has been
// wrong most often. Every state here exists to keep the widget from saying
// something it has not measured: "measuring" is not "idle", "no activity
// signal" is not "idle", and a server nobody has asked yet is not a server
// that failed to answer.
//
// It lives in plain JavaScript, executed by tests, because each of these was
// once a chain of ternaries inside a QML binding -- where the only thing a
// test could reach was the source text, and an assertion that reads source can
// pass against a comment.

// The bar light is driven by this. `unknown` counts nodes that are up but
// cannot report activity, so the UI can say so instead of implying idle --
// a node whose runtime has no counter must never be drawn as "quiet".
//
// `unread` counts the other absence: a server no probe has come back from yet.
// It is deliberately NOT folded into `down`. Rows are published as each host
// answers, so a fleet is routinely part-read, and counting the unread half as
// down made the panel announce "No servers reachable" over servers it had not
// finished asking -- including, for the length of a discovery sweep, one that
// was answering in milliseconds.
function fleetState(nodes) {
  var up = 0, down = 0, unread = 0, noTool = 0, active = 0, unknown = 0, tokens = 0, running = 0, waiting = 0
  var anyTokens = false, anyRunning = false, anyWaiting = false

  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    if (!n.read) { unread++; continue }
    if (n.probeTool === false) { noTool++; down++; continue }
    if (!n.reachable) { down++; continue }
    up++
    if (n.activity && n.activity.active) active++
    if (n.canReportActivity === false) unknown++
    if (n.activity && typeof n.activity.amount === "number") { tokens += n.activity.amount; anyTokens = true }
    if (typeof n.running === "number") { running += n.running; anyRunning = true }
    // Its own flag: a runtime can publish a queue depth without a running
    // gauge, and gating this on anyRunning reported null for it.
    if (typeof n.waiting === "number") { waiting += n.waiting; anyWaiting = true }
  }

  return {
    up: up,
    down: down,
    unread: unread,
    // Counted separately because it is one fact about this computer rather
    // than N facts about N servers, and the panel says it once.
    noTool: noTool,
    total: (nodes || []).length,
    active: active,
    unknown: unknown,
    busy: active > 0,
    tokens: anyTokens ? tokens : null,
    running: anyRunning ? running : null,
    waiting: anyWaiting ? waiting : null
  }
}

// What a row is allowed to claim about a node, in order of honesty.
//
// Pure: node in, string out. It lived in Panel.qml, where the row and the
// column measurement each needed it and only a source extractor could test it.
function stateLabel(node) {
  if (!node) return ""
  // Before "unreachable", because they are different claims and the row used
  // to make the wrong one: rows appear as soon as a host is configured, and a
  // row that has never been probed said "unreachable" -- the same word a
  // powered-off box gets -- until its first result landed.
  if (!node.read) return "measuring"
  // Not "unreachable": nothing on this machine could ask. Every server would
  // otherwise be drawn exactly as a room full of powered-off boxes, with the
  // real cause -- one missing package, here -- nowhere on screen.
  if (node.probeTool === false) return "no probe tool"
  // A server that completed the TCP handshake and then said nothing is wedged,
  // which is a different problem from one that is off, needs a different fix,
  // and is named in the README as a question this plugin answers.
  if (!node.reachable) return node.notResponding ? "not responding" : "unreachable"
  if (node.canReportActivity === false) return "no activity signal"
  if (node.firstReading) return "measuring"
  if (node.activity && node.activity.active) {
    // Rounded for display only. TGI's work counter is a histogram _sum and is
    // genuinely a float, so a delta arrives as 3.000000000000001 -- which
    // rendered literally, and at 31 characters was wider than the column had
    // been sized for. The unrounded value stays in diagnostics.
    return typeof node.activity.amount === "number" && node.activity.amount >= 1
      ? "working  " + Math.round(node.activity.amount) + " tok"
      : "working"
  }
  return "idle"
}

// The colour ladder behind stateLabel, as a token rather than a colour.
//
// It lived in NodeRow.qml as a chain of ternaries over Style colours, where
// nothing could execute it: four separate mutations of that chain -- drawing
// an unreachable node GREEN among them -- left the whole suite green. It is
// the same ladder stateLabel walks, for the same reason, so it belongs beside
// it and is pinned by the same kind of test.
//
// "measuring" is deliberately not the working tone. Amber for both made "I am
// generating" and "I cannot tell yet" the same colour at a glance, which is
// the one distinction this widget exists to draw.
function stateTone(node) {
  if (!node) return "unknown"
  if (!node.read) return "unknown"
  // Both are things that are WRONG, as against things that cannot be known.
  if (node.probeTool === false) return "down"
  if (!node.reachable) return "down"
  if (node.canReportActivity === false) return "unknown"
  if (node.firstReading) return "unknown"
  if (node.activity && node.activity.active) return "working"
  return "idle"
}

// Every value a column will have to hold, so it can be sized by MEASURING
// each one rather than guessing from string length.
//
// An unknown field name returns nothing rather than falling through to some
// other column: a typo used to measure the wrong field silently.
//
// Each entry is what the row RENDERS. The label used to fall back to the host
// when no nickname was set -- so with no nicknames configured the label column
// was measured to the full width of the address column and then drew the empty
// string, reserving a blank gutter as wide as the addresses beside it. Nearly
// a third of the popup, in the default configuration.
function columnValues(nodes, field) {
  var rows = nodes || []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (field === "label") out.push(String(rows[i].label || ""))
    else if (field === "host") out.push(String(rows[i].host || ""))
    else if (field === "state") out.push(stateLabel(rows[i]))
    else if (field === "runtime") {
      var rt = rows[i].runtime ? Runtimes.runtimeOf(rows[i].runtime) : null
      out.push(rt ? rt.label : String(rows[i].runtime || ""))
    } else {
      return []
    }
  }
  return out
}

// Has every configured node produced the two readings an activity claim needs?
//
// Was an imperative flag recomputed inside the publish path, which is where it
// could go stale; it is a pure function of the rows, so it is one.
function baselineReady(nodes) {
  var list = nodes || []
  if (list.length === 0) return false
  for (var i = 0; i < list.length; i++) {
    if (!list[i].read) return false
    if (list[i].reachable && list[i].firstReading) return false
  }
  return true
}

// Every configured server was asked, and none answered.
//
// The `unread` term is the point: without it this was true of a fleet that had
// simply not been asked yet, and it drives both the panel's "No servers
// reachable" and the bar icon's urgent badge.
function nothingReachable(fleet, configured) {
  if (!configured || !fleet) return false
  return fleet.total > 0 && fleet.unread === 0 && fleet.up === 0
}

// Would an unlit icon be a claim the widget cannot support?
//
// The bar icon is the primary surface, and it had exactly the defect the
// headline was rejected for one round earlier: `active: fleet.busy` with no
// third state, so a fleet that CANNOT report activity, a fleet still
// measuring, and a fleet measured and genuinely idle all drew the identical
// hollow icon -- and hollow is documented as "work stopped".
function activityUnknown(fleet, configured, ready) {
  if (!configured || !fleet || fleet.total === 0) return false
  // Both already carry the urgent badge; this is the quieter third state.
  if (nothingReachable(fleet, configured)) return false
  if (fleet.busy) return false
  if (!ready) return true
  return fleet.up > 0 && fleet.unknown >= fleet.up
}

// What the table currently says, as one string.
//
// Compared against the last published one so an unchanged fleet is not
// republished: a JS-array Repeater model has no diffing, so reassigning it
// rebuilds every row -- and a quiet fleet produces identical rows every few
// seconds, forever, in the process that draws the desktop.
//
// It covers exactly what a row RENDERS, and that has to stay exact in BOTH
// directions. Too narrow and a visible change is not redrawn; too wide and the
// table rebuilds for something nobody can see, which is the cost this exists
// to avoid. `port` was in here and no row has ever drawn it -- discovery
// re-detecting a port rebuilt every row in the fleet for a value that appears
// only in diagnostics. `running` was the same, and was fixed the other way:
// the row draws it now, because the README said it did.
//
// Deliberately not the sample or the timestamps: those change constantly
// without changing a pixel.
function signature(nodes) {
  var parts = []
  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    parts.push([n.host, n.label, n.runtime, stateLabel(n),
                n.model, n.running, n.waiting, n.cache].join("\u0001"))
  }
  return parts.join("\u0002")
}

// The panel's headline, in the same order of honesty as stateLabel.
//
// It lived in Panel.qml as a binding, where only a source extractor could
// reach it -- and it went wrong in the way that region always goes wrong. It
// consulted `busy` and `baselineReady` but never `unknown`, which fleetState
// computes for exactly this purpose, so a fleet of one OpenAI-compatible node
// (a runtime this file marks as unable to report activity) read "Idle" in the
// panel's largest type, directly above the line "1 server cannot report
// activity".
function headline(fleet, configured, ready) {
  if (!configured) return "No servers configured"
  if (!fleet || fleet.total === 0) return "Measuring"
  // Ahead of reachability, because it is the reason for it: with no curl there
  // is no probe, and "No servers reachable" would blame the servers.
  if (fleet.noTool > 0 && fleet.noTool === fleet.total) return "curl is not installed"
  // A server that has not answered yet is not a server that failed to answer.
  // This tested `up === 0` first, and an empty fleet has up === 0 -- so from
  // load until the first cycle completed the panel's largest type read "No
  // servers reachable" above the line "Checked 0 addresses", which is both a
  // false claim and a self-contradicting one. Measured at 16 seconds with one
  // slow host in the fleet; a full discovery sweep makes it 33.
  if (fleet.up === 0) return fleet.unread > 0 ? "Measuring" : "No servers reachable"
  if (!ready) return "Measuring"
  if (fleet.busy) {
    return fleet.active === 1 ? "1 server working" : fleet.active + " servers working"
  }
  // Nothing that could speak reported work. Saying "Idle" would be a claim
  // about servers that were never able to make one.
  if (fleet.unknown >= fleet.up) return "No activity signal"
  if (fleet.unknown > 0) return "Idle where it can tell"
  return "Idle"
}

// A node record before anything has been read, carrying forward only what a
// previous cycle established. One definition of the shape, so a new field
// cannot be added in Service.qml and forgotten in diagnostics.
function blankNode(host, label, prev) {
  var known = prev || {}
  return {
    host: host, label: label,
    // Whether a probe has COME BACK for this host, as opposed to whether it
    // succeeded. Rows are published as each host answers, so an unread row is
    // on screen, and everything it says has to be true of a server nobody has
    // heard from yet.
    read: false,
    // Whether curl exists on THIS machine, and whether the server accepted a
    // connection and then went silent. Both are failures that would otherwise
    // be indistinguishable from a box that lost power.
    probeTool: true, notResponding: false,
    reachable: false, runtime: known.runtime || null, port: known.port || null,
    canReportActivity: true, activity: { active: false, amount: null },
    running: null, waiting: null, cache: null, model: "",
    firstReading: false
  }
}

// One node, flattened for the diagnostics verb.
//
// It was assembled by hand in Service.qml, where it had already drifted from
// the record it summarises -- `label` and `cache` were each added to the node
// and forgotten here once.
function nodeSummary(n) {
  return {
    host: n.host, label: n.label || "", port: n.port, runtime: n.runtime,
    read: !!n.read, probeTool: n.probeTool !== false, notResponding: !!n.notResponding,
    reachable: n.reachable, canReportActivity: n.canReportActivity,
    active: !!(n.activity && n.activity.active),
    tokens: n.activity ? n.activity.amount : null,
    running: n.running, waiting: n.waiting, cache: n.cache,
    model: n.model || "", firstReading: n.firstReading
  }
}
