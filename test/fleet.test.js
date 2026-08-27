// What a row, a fleet and the bar icon are allowed to CLAIM.
//
// This is the honesty layer, and the part of the plugin that has been wrong
// most often: "measuring" is not "idle", "no activity signal" is not "idle",
// and a server nobody has asked yet is not a server that failed to answer.
// Every state here is pinned to the condition that earns it, in order, because
// twice now a state could be deleted outright with the suite still green.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { Metrics, Fleet, Poll, readingOf, codeOf } = require("./harness.js")
const { VLLM } = require("./fixtures.js")

test("a restart is not negative work, and not evidence of no work", () => {
  // Reporting it as activity would flash the light on every server restart.
  // Reporting it as { active: false } is worse: stateLabel renders that as
  // "idle", so a vLLM engine that had just restarted was drawn bold green
  // "idle" over its own "4 running  2 queued  90% cache".
  const a = Metrics.readSample("vllm", VLLM)
  const b = Metrics.readSample("vllm", VLLM.replace("48456.0", "12.0"))
  assert.strictEqual(Metrics.activityBetween(a, b), null,
    "an uncomparable pair produced an answer about work")

  // End to end: a restarted node says "measuring", not "idle", and keeps
  // reporting the numbers it can actually support.
  const busy = VLLM.replace("48456.0", "12.0")
                   .replace(/(vllm:num_requests_running[^ ]*) 0\.0/, "$1 4.0")
  const res = readingOf("PORT 8000\nRT vllm\n" + busy,
                        { runtime: "vllm", port: 8000, sample: a })
  assert.equal(Fleet.stateLabel(res.node), "measuring",
    "a restarted server serving requests was drawn as idle")
  assert.equal(res.node.running, 4, "the numbers it can support were dropped")

  // And the next comparable pair clears it.
  const after = readingOf("PORT 8000\nRT vllm\n" + VLLM, res.state)
  assert.notEqual(Fleet.stateLabel(after.node), "measuring",
    "measuring never clears")
})

test("a counter the exporter skipped does not become an idle claim", () => {
  // A partial scrape -- the file's own comment calls it what a version skew
  // produces -- left prev.work null. The next poll had both a real counter and
  // a 500-token jump, and the widget said "idle".
  const full = "vllm:generation_tokens_total{model=\"m\"} 1000\n"
  const partial = "vllm:num_requests_running{model=\"m\"} 1\n"
  const later = "vllm:generation_tokens_total{model=\"m\"} 1500\n"

  const one = readingOf("PORT 8000\nRT vllm\n" + full, {})
  const two = readingOf("PORT 8000\nRT vllm\n" + partial, one.state)
  assert.equal(Fleet.stateLabel(two.node), "no activity signal")

  const three = readingOf("PORT 8000\nRT vllm\n" + later, two.state)
  assert.notEqual(Fleet.stateLabel(three.node), "idle",
    "500 generated tokens were reported as an idle server")
  assert.equal(Fleet.stateLabel(three.node), "measuring")
})

test("fleetState counts up, down, and busy", () => {
  const s = Fleet.fleetState([
    { read: true, reachable: true, activity: { active: true, amount: 12 }, running: 1, waiting: 0 },
    { read: true, reachable: true, activity: { active: false, amount: 0 }, running: 0, waiting: 0 },
    { read: true, reachable: false }
  ])
  assert.equal(s.up, 2)
  assert.equal(s.down, 1)
  assert.equal(s.active, 1)
  assert.equal(s.busy, true)
  assert.equal(s.tokens, 12)
  assert.equal(s.running, 1)
})

test("a node that cannot report activity is counted as unknown, not idle", () => {
  // LM Studio and friends expose no metrics. Drawing them dark would claim
  // they are quiet when we simply cannot see them.
  const s = Fleet.fleetState([
    { read: true, reachable: true, canReportActivity: false, activity: { active: false, amount: null } }
  ])
  assert.equal(s.unknown, 1)
  assert.equal(s.busy, false)
  assert.equal(s.tokens, null, "must not report 0 tokens for a node that cannot count")
})

test("fleetState handles an empty fleet", () => {
  const s = Fleet.fleetState([])
  assert.equal(s.total, 0)
  assert.equal(s.busy, false)
  assert.equal(s.tokens, null)
})

test("a column is measured against exactly what its rows render", () => {
  // This list is what the column is sized to, so anything in it that a row
  // does NOT draw becomes reserved empty space. The label used to fall back to
  // the host when no nickname was set: with no nicknames configured -- the
  // default -- the label column was measured to the full width of the address
  // column and then drew "", reserving a blank gutter as wide as the addresses
  // beside it. Measured in a real Qt engine at 486px of row content where 347
  // was the truth: 29% of the popup.
  const unnamed = Object.assign(
    Fleet.blankNode("192.0.2.10", "", { runtime: "vllm" }), { read: true, reachable: true })
  assert.deepEqual(Fleet.columnValues([unnamed], "label"), [""],
    "the label column is measured against something the row does not draw")
  assert.deepEqual(Fleet.columnValues([unnamed], "host"), ["192.0.2.10"])
  assert.deepEqual(Fleet.columnValues([unnamed], "runtime"), ["vLLM"])
  assert.deepEqual(Fleet.columnValues([unnamed], "state"), ["idle"])

  // A nickname, once set, IS what the row draws.
  const named = Object.assign(
    Fleet.blankNode("192.0.2.10", "DGX", {}), { read: true, reachable: true })
  assert.deepEqual(Fleet.columnValues([named], "label"), ["DGX"])

  // An unknown column name measures nothing rather than falling through to the
  // runtime label, which is what a typo used to do, silently.
  assert.deepEqual(Fleet.columnValues([named], "nickname"), [])

  // And the widest value is chosen by MEASURING each one, not by counting
  // characters: "no activity signal" is longer than "working  9999 tok" and
  // lays out narrower.
  const measure = codeOf("ColumnWidths.qml").slice(
    codeOf("ColumnWidths.qml").indexOf("function _widest"))
  assert.ok(/metrics\.text = values\[i\]/.test(measure),
    "only one candidate per column is measured")
  assert.ok(!/\.length > best\.length/.test(measure),
    "the widest value is still chosen by character count")

  // Every column must be re-measured when the rows change. Dropping this one
  // handler leaves _measure running once, at load, against an empty table --
  // every width stays 0, every column goes invisible, and the panel renders
  // nothing at all. No node test can reach it; QML wiring is source-checked or
  // not checked.
  const src = codeOf("ColumnWidths.qml")
  assert.ok(/onNodesChanged: _measure\(\)/.test(src), "columns are never re-measured")
  assert.ok(/onFontFamilyChanged: _measure\(\)/.test(src), "a font change never re-measures")
  assert.ok(/Component\.onCompleted: _measure\(\)/.test(src), "columns are never measured at load")
})

test("stateLabel is one definition, used by both the row and the measurement", () => {
  // It lived in Panel.qml, where the row and the column measurement each
  // needed it and only a source extractor could test it.
  assert.equal(typeof Fleet.stateLabel, "function")
  // The row renders it; the measurement sizes for it through columnValues,
  // which is the same definition reached one call further along.
  assert.ok(/Fleet\.stateLabel\(/.test(codeOf("NodeRow.qml")),
    "NodeRow.qml does not use the shared state label")
  assert.ok(/Fleet\.columnValues\(widths\.nodes, "state"\)/.test(codeOf("ColumnWidths.qml")),
    "ColumnWidths.qml sizes the state column from its own copy")
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.ok(!/function stateTextFor/.test(panel), "the old copy is back in Panel.qml")
})

test("every state a row can show is pinned to the condition that earns it", () => {
  // Both of the states that exist ONLY to avoid lying could be deleted from
  // stateLabel with the suite green: inverting "unreachable" to "idle", and
  // removing "measuring" entirely, each left 87/87 passing. The label was
  // asserted for the states that make a claim and not for the two that
  // withhold one -- exactly backwards.
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})

  assert.equal(Fleet.stateLabel(node({ reachable: false })), "unreachable")
  assert.equal(Fleet.stateLabel(node({ canReportActivity: false })), "no activity signal")
  assert.equal(Fleet.stateLabel(node({ firstReading: true })), "measuring")
  assert.equal(Fleet.stateLabel(node({ activity: { active: true, amount: 12 } })), "working  12 tok")
  assert.equal(Fleet.stateLabel(node({ activity: { active: true, amount: null } })), "working")
  assert.equal(Fleet.stateLabel(node()), "idle")
  assert.equal(Fleet.stateLabel(null), "")

  // Order matters as much as the strings: an unreachable node also carries
  // whatever the last cycle left behind, so a later branch must not win.
  assert.equal(Fleet.stateLabel(node({
    reachable: false, firstReading: true, activity: { active: true, amount: 9 } })),
    "unreachable", "a dead node was drawn as working")
  assert.equal(Fleet.stateLabel(node({
    canReportActivity: false, activity: { active: true, amount: 9 } })),
    "no activity signal", "a node that cannot report was drawn as working")
  assert.equal(Fleet.stateLabel(node({
    firstReading: true, activity: { active: true, amount: 9 } })),
    "measuring", "a first reading was drawn as a measured delta")

  // Every one of them must be a state the row can actually reach.
  const shown = ["unreachable", "no activity signal", "measuring", "working", "idle"]
  const row = codeOf("NodeRow.qml") + codeOf("ColumnWidths.qml")
  for (const st of shown) {
    assert.ok(row.indexOf(st) > -1 || /Fleet\.stateLabel/.test(row),
      `${st} is never rendered`)
  }
})

test("the baseline gate holds the headline until every node has been compared", () => {
  // `baselineReady` appeared ZERO times in this suite, though it is the only
  // thing standing between "Measuring" and an "Idle" the widget has not
  // earned. Its rule: any reachable node still on its first reading holds the
  // whole fleet at Measuring.
  // It was an imperative flag recomputed inside the publish path; it is a pure
  // function of the rows now, so this executes it instead of reading QML.
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})

  assert.equal(Fleet.baselineReady([]), false, "an empty fleet reported a ready baseline")
  assert.equal(Fleet.baselineReady([node({ firstReading: true })]), false,
    "a node still on its first reading did not hold the baseline open")
  assert.equal(Fleet.baselineReady([node()]), true)

  // An unreachable node must NOT hold the fleet open forever: it will never
  // produce a first reading, so the gate would never close.
  assert.equal(Fleet.baselineReady([node({ reachable: false, firstReading: true })]), true,
    "an unreachable node holds the baseline open indefinitely")

  // A host no probe has come back from DOES hold it open -- nothing is known
  // about it at all, which is a different thing from knowing it is down.
  assert.equal(Fleet.baselineReady([Fleet.blankNode("192.0.2.11", "", {})]), false,
    "an unprobed node was counted as an established baseline")

  // And the headline honours it.
  assert.equal(Fleet.headline(
    { total: 1, up: 1, unread: 0, unknown: 0, busy: false, active: 0 }, true, false), "Measuring")

  // The service derives it rather than keeping a second copy.
  assert.ok(/baselineReady: Fleet\.baselineReady\(nodes\)/.test(codeOf("Service.qml")),
    "Service.qml keeps its own baseline flag")
})

test("rows are published in a stable order", () => {
  // Without the sort, row order follows whichever probe answered first -- and
  // rows are published as each host answers now, so that is every single poll.
  const servers = [{ host: "192.0.2.30", label: "c" },
                   { host: "192.0.2.10", label: "a" },
                   { host: "192.0.2.20", label: "b" }]
  assert.deepEqual(Poll.tableRows(servers, {}, {}).map(r => r.host),
    ["192.0.2.10", "192.0.2.20", "192.0.2.30"])

  // And order must not depend on which hosts have answered so far.
  const answered = Object.assign(
    Fleet.blankNode("192.0.2.30", "c", {}), { read: true, reachable: true })
  assert.deepEqual(Poll.tableRows(servers, { "192.0.2.30": answered }, {}).map(r => r.host),
    ["192.0.2.10", "192.0.2.20", "192.0.2.30"])

  // A host nothing has come back from gets a row that says so, NOT one that
  // says the server is unreachable.
  assert.equal(Fleet.stateLabel(Poll.tableRows(servers, {}, {})[0]), "measuring")
})

test("an unchanged fleet is not republished", () => {
  // A JS-array Repeater model has no diffing, so reassigning it destroys and
  // rebuilds every row. A quiet fleet produces identical rows every few
  // seconds, forever, in the process that draws the desktop.
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})

  assert.equal(Fleet.signature([node()]), Fleet.signature([node()]),
    "two identical tables have different signatures")

  // Anything a row RENDERS must change it. The list is what NodeRow.qml draws:
  // the three columns, the state, and the four values on the detail line --
  // plus the three flags stateLabel is computed from.
  const base = Fleet.signature([node()])
  for (const [field, value] of [["label", "other"], ["runtime", "ollama"],
                                ["model", "qwen"],
                                ["running", 3], ["waiting", 1], ["cache", 0.5],
                                ["read", false],
                                ["reachable", false], ["firstReading", true],
                                ["canReportActivity", false]]) {
    assert.notEqual(Fleet.signature([node({ [field]: value })]), base,
      `a change to ${field} would not redraw the row`)
  }
  assert.notEqual(Fleet.signature([node(), node()]), base, "row count is not covered")

  // And things a row does NOT render must not, or the comparison saves nothing.
  const busy = node({ activity: { active: true, amount: 12 } })
  assert.notEqual(Fleet.signature([busy]), base, "the state label is not covered")
  assert.equal(Fleet.signature([node({ activity: { active: false, amount: null } })]), base,
    "a reading that changed no visible value forced a redraw")

  // The service must compare before assigning.
  const svc = codeOf("Service.qml")
  const at = svc.indexOf("nodes = _collected")
  assert.ok(svc.slice(Math.max(0, at - 260), at).indexOf("Fleet.signature(") > -1,
    "the table is republished without checking whether it changed")
})

test("the signature is no WIDER than what a row renders", () => {
  // The other direction, and it costs the same thing the mechanism exists to
  // avoid. A JS-array Repeater model has no diffing, so a signature that
  // changes for an invisible value destroys and rebuilds every row -- a
  // CursorSurface and five Texts each -- in the process that draws the whole
  // desktop, for a change nobody can see.
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})
  const base = Fleet.signature([node()])

  // `port` appears only in the diagnostics verb. Discovery re-detecting one
  // used to rebuild the entire table.
  assert.equal(Fleet.signature([node({ port: 9999 })]), base,
    "a value no row draws still forces a full rebuild")

  // Every field the signature DOES carry has to be reachable from NodeRow.qml,
  // or it is the same defect wearing a different name.
  const row = codeOf("NodeRow.qml")
  for (const field of ["label", "host", "runtime", "model", "running", "waiting", "cache"]) {
    assert.ok(new RegExp(`node\\.${field}\\b`).test(row),
      `the signature carries ${field}, which no row renders`)
  }
})

test("the headline never claims idle for a fleet that cannot tell", () => {
  // One OpenAI-compatible node -- the runtime the table itself marks
  // noActivity -- read "Idle" in the panel's largest type, directly above
  // "1 server cannot report activity". The count was already there; the
  // headline never asked for it.
  const openai = Fleet.blankNode("192.0.2.20", "lmstudio", { runtime: "openai" })
  openai.read = true
  openai.reachable = true
  openai.canReportActivity = false
  const alone = Fleet.fleetState([openai])
  assert.equal(alone.unknown, 1)
  assert.equal(Fleet.headline(alone, true, true), "No activity signal",
    "a fleet that cannot report activity was called idle")

  // Mixed: one node genuinely idle, one that cannot say. Neither "Idle" nor
  // "No activity signal" is the whole truth, and the headline must not pick
  // the flattering half.
  const quiet = Fleet.blankNode("192.0.2.21", "vllm", { runtime: "vllm" })
  quiet.read = true
  quiet.reachable = true
  const mixed = Fleet.fleetState([openai, quiet])
  assert.equal(Fleet.headline(mixed, true, true), "Idle where it can tell")

  // An all-reporting quiet fleet still says Idle, or the above proves nothing.
  assert.equal(Fleet.headline(Fleet.fleetState([quiet]), true, true), "Idle")

  // And the earlier states still win, in order.
  assert.equal(Fleet.headline(alone, false, true), "No servers configured")
  assert.equal(Fleet.headline(alone, true, false), "Measuring")

  // An empty fleet is one nobody has asked yet, NOT one that failed to answer.
  // This line used to assert the opposite, so the suite pinned the defect in
  // place: the panel announced "No servers reachable" from load until the
  // first cycle finished, over the line "Checked 0 addresses".
  assert.equal(Fleet.headline(Fleet.fleetState([]), true, true), "Measuring")

  // Working outranks unknown: something demonstrably is doing work.
  const busy = Fleet.blankNode("192.0.2.22", "vllm", { runtime: "vllm" })
  busy.read = true
  busy.reachable = true
  busy.activity = { active: true, amount: 12 }
  assert.equal(Fleet.headline(Fleet.fleetState([openai, busy]), true, true),
    "1 server working")

  // The panel must use it rather than keeping a second copy.
  const panel = codeOf("Panel.qml")
  assert.ok(/Fleet\.headline\(/.test(panel), "Panel.qml does not use it")
  assert.ok(!/return "Idle"/.test(panel), "Panel.qml still decides the headline itself")
})

test("the node record has one definition", () => {
  // It was built inline in Service.qml, so a new field could be added there
  // and forgotten in diagnostics.
  const n = Fleet.blankNode("h", "L", { runtime: "vllm", port: 8000 })
  assert.equal(n.host, "h")
  assert.equal(n.label, "L")
  assert.equal(n.runtime, "vllm", "what a previous cycle learned must carry forward")
  assert.equal(n.port, 8000)
  assert.equal(n.reachable, false, "a fresh record must not claim reachability")
  assert.equal(n.canReportActivity, true)
  assert.deepEqual(n.activity, { active: false, amount: null })
  // assert.equal is loose, so a field name that no longer exists compares
  // undefined == null and passes vacuously -- "loaded" sat here doing that.
  for (const f of ["running", "waiting", "cache"]) {
    assert.ok(f in n, `blankNode no longer carries ${f}`)
    assert.strictEqual(n[f], null, f)
  }
  assert.equal("loaded" in n, false, "an unread field crept back into the record")
  assert.equal(n.model, "")
  // With no history it carries nothing.
  const fresh = Fleet.blankNode("h", "", null)
  assert.equal(fresh.runtime, null)
  assert.equal(fresh.port, null)
  assert.ok(!/var node = \{/.test(codeOf("Service.qml")), "the inline copy is back")
})

test("the diagnostics summary reports every field the node record carries", () => {
  // It was assembled by hand in Service.qml, where it had already drifted from
  // the record it summarises: `label` and `cache` were each added to the node
  // and forgotten here once.
  const node = Fleet.blankNode("h", "Nickname", { runtime: "vllm", port: 8000 })
  node.reachable = true
  node.running = 2; node.waiting = 1; node.cache = 0.5; node.model = "qwen"
  node.activity = { active: true, amount: 42 }

  const out = Fleet.nodeSummary(node)
  assert.equal(out.host, "h"); assert.equal(out.label, "Nickname")
  assert.equal(out.port, 8000); assert.equal(out.runtime, "vllm")
  assert.equal(out.reachable, true); assert.equal(out.active, true)
  assert.equal(out.tokens, 42); assert.equal(out.running, 2)
  assert.equal(out.waiting, 1); assert.equal(out.cache, 0.5)
  assert.equal(out.model, "qwen")

  // Anything the record carries and the summary drops is invisible in the one
  // place a user can inspect. `activity` is folded into active/tokens.
  const carried = Object.keys(node).filter(k => k !== "activity")
  for (const k of carried) {
    assert.ok(k in out, `the node record carries ${k} and diagnostics drops it`)
  }
})

test("the colour ladder is pinned to the same conditions as the label", () => {
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})

  // In order of honesty, exactly as stateLabel walks it.
  assert.equal(Fleet.stateTone(null), "unknown", "a missing node was given a tone")
  assert.equal(Fleet.stateTone(node({ read: false })), "unknown",
    "a host nobody has heard from was coloured as though it had answered")
  assert.equal(Fleet.stateTone(node({ reachable: false })), "down")
  assert.equal(Fleet.stateTone(node({ canReportActivity: false })), "unknown")
  assert.equal(Fleet.stateTone(node({ firstReading: true })), "unknown")
  assert.equal(Fleet.stateTone(node({ activity: { active: true, amount: 5 } })), "working")
  assert.equal(Fleet.stateTone(node()), "idle")

  // Down outranks everything: an unreachable node must never be drawn green,
  // whatever stale flags its row still carries.
  assert.equal(Fleet.stateTone(node({ reachable: false, firstReading: true,
                                      activity: { active: true, amount: 9 } })), "down")

  // "measuring" must not share a colour with "working". Amber for both made
  // "I am generating" and "I cannot tell yet" identical at a glance, which is
  // the one distinction this widget exists to draw.
  assert.notEqual(Fleet.stateTone(node({ firstReading: true })),
                  Fleet.stateTone(node({ activity: { active: true, amount: 5 } })),
                  "measuring and working are the same colour again")

  // And the row takes the ladder from here rather than keeping a copy.
  const row = codeOf("NodeRow.qml")
  assert.ok(/Fleet\.stateTone\(node\)/.test(row), "NodeRow.qml has its own colour ladder again")
  assert.ok(!/node\.canReportActivity === false\) return dim/.test(row),
    "the old inline ladder is back")
})

test("the bar icon never draws an idle fleet it has not measured", () => {
  // `active: fleet.busy` with no third state: a fleet that CANNOT report
  // activity, a fleet still measuring, and a fleet measured and genuinely
  // quiet all drew the identical hollow icon -- and hollow is documented in
  // FleetIcon.qml as work having stopped. This is the headline's own defect
  // from the previous round, left unfixed one surface up and in the more
  // prominent place.
  const fleet = (over) => Object.assign(
    { total: 1, up: 1, down: 0, unread: 0, unknown: 0, active: 0, busy: false }, over)

  assert.equal(Fleet.activityUnknown(fleet(), true, true), false,
    "a measured, quiet fleet is not unknown")
  assert.equal(Fleet.activityUnknown(fleet({ unknown: 1 }), true, true), true,
    "a fleet that cannot report activity drew a plain idle icon")
  assert.equal(Fleet.activityUnknown(fleet(), true, false), true,
    "a fleet still measuring drew a plain idle icon")
  assert.equal(Fleet.activityUnknown(fleet({ busy: true, active: 1 }), true, true), false,
    "a working fleet is not unknown")

  // A partly-unknown fleet is not: something in it genuinely reported quiet,
  // and the headline says "Idle where it can tell". The two must agree.
  assert.equal(Fleet.activityUnknown(
    { total: 2, up: 2, down: 0, unread: 0, unknown: 1, active: 0, busy: false }, true, true), false)

  // Unconfigured and nothing-reachable carry the urgent badge instead; this is
  // the quieter third state and must not double up on them.
  assert.equal(Fleet.activityUnknown(fleet(), false, true), false)
  assert.equal(Fleet.activityUnknown(
    { total: 1, up: 0, down: 1, unread: 0, unknown: 0, active: 0, busy: false }, true, true), false)

  // Both icons -- the bar one and the panel's -- must take it.
  const panel = codeOf("Panel.qml")
  assert.equal((panel.match(/unknown: root\.activityUnknown/g) || []).length, 2,
    "one of the two icons still has no third state")
  assert.ok(/Fleet\.activityUnknown\(/.test(panel), "Panel.qml computes it itself")
  const icon = codeOf("FleetIcon.qml")
  assert.ok(/visible: root\.warning \|\| root\.unknown/.test(icon),
    "the icon cannot show the third state")
})

test("a server that has not answered yet is not a server that failed", () => {
  // `up === 0` is also true of a fleet nobody has asked. The panel announced
  // "No servers reachable" over the line "Checked 0 addresses" from load until
  // the first cycle finished -- measured at 16 seconds, with one of those
  // servers answering in milliseconds throughout.
  const asked = { total: 2, up: 0, down: 2, unread: 0, unknown: 0, active: 0, busy: false }
  const asking = { total: 2, up: 0, down: 1, unread: 1, unknown: 0, active: 0, busy: false }

  assert.equal(Fleet.nothingReachable(asked, true), true)
  assert.equal(Fleet.nothingReachable(asking, true), false,
    "a fleet still being probed was declared unreachable")
  assert.equal(Fleet.nothingReachable(Fleet.fleetState([]), true), false,
    "an empty table was declared unreachable")
  assert.equal(Fleet.nothingReachable(asked, false), false, "nothing is configured")

  assert.equal(Fleet.headline(asked, true, true), "No servers reachable")
  assert.equal(Fleet.headline(asking, true, true), "Measuring")

  // fleetState must keep the two apart in the first place.
  const blank = Fleet.blankNode("192.0.2.10", "", {})
  const dead = Object.assign(Fleet.blankNode("192.0.2.11", "", {}), { read: true })
  const state = Fleet.fleetState([blank, dead])
  assert.equal(state.unread, 1, "an unprobed host was not counted as unread")
  assert.equal(state.down, 1, "a probed, unreachable host was not counted as down")
  assert.equal(state.total, 2)

  // And the panel takes both predicates from here.
  const panel = codeOf("Panel.qml")
  assert.ok(/Fleet\.nothingReachable\(fleet\.fleet, configured\)/.test(panel),
    "Panel.qml still derives it from up === 0")
})
