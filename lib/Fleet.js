.pragma library
.import "Runtimes.js" as Runtimes

// What a row, a fleet and the bar icon are allowed to CLAIM.
//
// The honesty layer. Every state exists to stop the widget saying something it
// has not measured: "measuring" is not "idle", "no activity signal" is not
// "idle", and a server nobody has asked is not one that failed to answer.
//
// In plain JavaScript, and executed by tests, because as QML bindings the only
// thing a test could reach was the source text -- and an assertion that reads
// source can pass against a comment.

// The bar light is driven by this, and it counts two different absences.
//
// `unknown`: up, but cannot report activity -- never to be drawn as "quiet".
// `unread`: no probe has come back yet. Deliberately NOT folded into `down`.
// Rows publish as each host answers, so a fleet is routinely part-read, and
// counting the unread half as down announces "No servers reachable" over
// servers still being asked.
function fleetState(nodes) {
  var up = 0, down = 0, unread = 0, noTool = 0, active = 0, unknown = 0, tokens = 0, running = 0, waiting = 0
  var anyTokens = false, anyRunning = false, anyWaiting = false

  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    if (n.probeTool === false) { noTool++; unread++; continue }
    if (!n.read) { unread++; continue }
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
    // One fact about this computer rather than N facts about N servers, which
    // is why no ROW says it -- they read "measuring", because nothing here
    // could ask them anything. The panel says it once.
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

// What a row is allowed to claim about a node, in order of honesty. One
// definition: the row renders it and the column measurement sizes for it.
function stateLabel(node) {
  if (!node) return ""
  // Before "unreachable": rows appear as soon as a host is configured, and
  // "not asked yet" must not borrow the word a powered-off box gets.
  if (!node.read) return "measuring"
  // A server that completed the TCP handshake and then said nothing is wedged,
  // which is a different problem from one that is off, needs a different fix,
  // and is named in the README as a question this plugin answers.
  if (!node.reachable) return node.notResponding ? "not responding" : "unreachable"
  if (node.canReportActivity === false) return "no activity signal"
  if (node.firstReading) return "measuring"
  if (node.activity && node.activity.active) {
    // Rounded for display only -- TGI's counter is a histogram _sum, so a delta
    // arrives as 3.000000000000001. The exact value stays in diagnostics.
    return typeof node.activity.amount === "number" && node.activity.amount >= 1
      ? "working  " + Math.round(node.activity.amount) + " tok"
      : "working"
  }
  return "idle"
}

// The same ladder as stateLabel, as a token rather than a colour -- so the
// thing the eye reads is pinned by a test, like the thing the reader reads.
//
// "measuring" is deliberately NOT the working tone: one colour for both makes
// "I am generating" and "I cannot tell yet" identical at a glance, which is
// the one distinction this widget exists to draw.
function stateTone(node) {
  if (!node) return "unknown"
  if (!node.read) return "unknown"
  if (!node.reachable) return "down"
  if (node.canReportActivity === false) return "unknown"
  if (node.firstReading) return "unknown"
  if (node.activity && node.activity.active) return "working"
  return "idle"
}

// Every value a column must hold, so it can be sized by MEASURING each one
// rather than guessing from string length.
//
// Each entry is exactly what the row RENDERS -- a label falling back to the
// host reserves a gutter as wide as the addresses and then draws "". An
// unknown field returns nothing rather than falling through to another column.
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
// A pure function of the rows, so it cannot go stale.
function baselineReady(nodes) {
  var list = nodes || []
  if (list.length === 0) return false
  for (var i = 0; i < list.length; i++) {
    if (!list[i].read) return false
    if (list[i].reachable && list[i].firstReading) return false
  }
  return true
}

// Every configured server was asked, and none answered. The `unread` term is
// the point: without it this is also true of a fleet nobody has asked yet, and
// it drives both the panel's headline and the icon's urgent badge.
function nothingReachable(fleet, configured) {
  if (!configured || !fleet) return false
  return fleet.total > 0 && fleet.unread === 0 && fleet.up === 0
}

// Would an unlit icon be a claim the widget cannot support?
//
// Without a third state, a fleet that CANNOT report activity, a fleet still
// measuring, and a fleet measured and genuinely idle all draw the identical
// hollow icon -- which FleetIcon.qml documents as work having stopped.
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
// It covers exactly what a row RENDERS, and must stay exact in BOTH
// directions: too narrow and a visible change is not redrawn, too wide and the
// table rebuilds for something nobody can see -- which is the cost this exists
// to avoid. Not the sample or the timestamps: they change without changing a
// pixel.
function signature(nodes) {
  var parts = []
  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    parts.push([n.host, n.label, n.runtime, stateLabel(n),
                n.model, n.running, n.waiting, n.cache].join("\u0001"))
  }
  return parts.join("\u0002")
}

// The panel's headline, in the same order of honesty as stateLabel -- and it
// must consult `unknown`, or a fleet that cannot report activity reads "Idle"
// in the largest type on screen, above a line saying it cannot report.
function headline(fleet, configured, ready) {
  if (!configured) return "No servers configured"
  if (!fleet || fleet.total === 0) return "Measuring"
  // Ahead of reachability, because it is the reason for it: with no curl there
  // is no probe, and "No servers reachable" would blame the servers.
  if (fleet.noTool > 0 && fleet.noTool === fleet.total) return "curl is not installed"
  // A server not yet answered is not a server that failed. Testing `up === 0`
  // first reads "No servers reachable" above "Checked 0 addresses" -- false and
  // self-contradicting -- for as long as the first sweep takes.
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
    // Whether a probe has COME BACK, as against whether it succeeded. Rows
    // publish as each host answers, so an unread row is on screen and
    // everything it says must be true of a server nobody has heard from.
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

// One node, flattened for the diagnostics verb. Beside blankNode, so a field
// added to the record cannot be forgotten here.
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
