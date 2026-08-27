// The shape of the plugin, which no other tool in this repo checks.
//
// QML is parsed by nothing here, and logic living in QML can only be reached
// by a test through a source extractor -- so the file layout, the wiring
// between the panel and its rows, and the handful of QML-only defences are
// asserted here or they drift back.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { Text, Fleet, codeOf, codeLines, sourceOf } = require("./harness.js")
const { SERVICE, runPanelDetail } = require("./qml.js")

test("the probe pool is an Instantiator, and callers address it as one", () => {
  // A Repeater can only create Items; Process is a plain QtObject, so the pool
  // silently produced nothing and every host reported unreachable. The only
  // symptom was "Delegate must be of Item type" in the shell log.
  assert.ok(/Instantiator\s*\{/.test(SERVICE), "the probe pool is not an Instantiator")
  assert.ok(/probePool\.objectAt\(/.test(SERVICE),
    "the pool is addressed with itemAt(), which is Repeater-only and returns null here")
  assert.ok(!/probePool\.itemAt\(/.test(SERVICE), "itemAt() would return null for every host")
})

test("the plugin has ONE name, everywhere a person sees it", () => {
  // The catalog listing reads manifest.name, the bar picker reads
  // displayName, and the panel draws its own title. They disagreed --
  // "LLM Fleet Activity" in the listing against "LLM Fleet" on screen --
  // which is the kind of thing nobody notices until it is published.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")

  const title = (panel.match(/title: "([^"]+)"/) || [])[1]
  const heading = readme.split("\n")[0].replace(/^#\s*/, "").trim()
  const names = [manifest.name, manifest.barWidget.displayName, title, heading]
  assert.equal(new Set(names).size, 1, `names disagree: ${JSON.stringify(names)}`)

  // The id is what shell.json keys on: changing it orphans every existing
  // configuration, so it is deliberately NOT tied to the display name.
  assert.equal(manifest.id, "veepee.fleet")
})

test("the diagnostics command in the source is the one that works", () => {
  // The comment named `omarchy-shell veepee.fleet diagnostics`, which is not a
  // real command. Only the qs ipc form is.
  assert.ok(!/omarchy-shell veepee\.fleet diagnostics/.test(SERVICE),
    "the source still names a command that does not exist")
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")
  const cmd = "qs -p /usr/share/omarchy/shell ipc call veepee.fleet diagnostics"
  assert.ok(SERVICE.includes(cmd) && readme.includes(cmd),
    "source and README disagree on the diagnostics command")
})

test("the settings label documents every form the parser accepts", () => {
  // The schema label is what a user reads in the settings UI, and it never
  // mentioned the nickname form the README documents.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  const label = manifest.barWidget.schema.find(f => f.key === "servers").label
  for (const form of ["host", "host:port", "host=Nickname"]) {
    assert.ok(label.includes(form), `the settings label omits ${form}: ${label}`)
  }
})

test("configError actually produces a message, not a thrown binding", () => {
  // clampField was CALLED by Service.qml and never defined anywhere
  // -- carried over from a sibling plugin from memory. The binding threw, QML
  // left configError empty, and the bad-address message never appeared: the
  // exact silent drop the feature exists to end.
  //
  // The old test asserted both halves of the wiring (the parser rejects, the
  // panel reads the property) and never the function joining them. This
  // evaluates the real expression.
  assert.equal(typeof Text.clampField, "function", "Text.clampField does not exist")

  const at = SERVICE.indexOf("readonly property string configError:")
  assert.notEqual(at, -1, "the configError property could not be found")
  const expr = SERVICE.slice(SERVICE.indexOf(":", at) + 1, SERVICE.indexOf("\n\n", at))

  const evaluate = (rejected) => new Function("Text", "configured",
    "return (" + expr.trim() + ")")(Text, { rejected: rejected })

  assert.equal(evaluate([]), "", "an empty reject list must say nothing")
  const one = evaluate(["host|x"])
  assert.ok(one.length > 0 && one.includes("host|x"), `no message for one bad address: ${one}`)
  const two = evaluate(["a|b", "c&d"])
  assert.ok(two.includes("a|b") && two.includes("c&d"), `no message for two: ${two}`)
  // And it must be clamped rather than unbounded.
  const many = evaluate(Array.from({ length: 200 }, (_, i) => "bad|" + i))
  assert.ok(many.length <= 200, `an unbounded error message: ${many.length} chars`)
})

test("every Text that renders anything declares PlainText", () => {
  // The README's headline safety claim, and NOTHING enforced it: deleting all
  // seven declarations left the whole suite green. QML is parsed by no tool in
  // this repo, so a Text added later is the defence most likely to be lost
  // silently.
  // EVERY .qml in the plugin, discovered from disk rather than listed. The
  // list used to be ["Panel.qml", "FleetIcon.qml"] -- written when all seven
  // Text blocks lived in Panel.qml. The split moved five of them into
  // NodeRow.qml, the file that renders the model id, host, state and queue
  // depth: every server-controlled string. FleetIcon.qml has no Text at all,
  // so the guard was passing vacuously on one file and covering two of seven
  // Texts on the other. Deleting every declaration from NodeRow.qml left the
  // whole suite green.
  const root = path.join(__dirname, "..")
  const qmlFiles = fs.readdirSync(root).filter(f => f.endsWith(".qml"))
  assert.ok(qmlFiles.length >= 4, `expected the plugin's QML files, saw ${qmlFiles}`)
  let totalText = 0
  for (const file of qmlFiles) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    const declared = (src.match(/\bText\s*\{/g) || []).length
    const plain = (src.match(/textFormat:\s*Text\.PlainText/g) || []).length
    assert.equal(plain, declared,
      `${file}: ${declared} Text blocks but ${plain} declare PlainText`)
    assert.ok(!/Text\.AutoText|Text\.RichText|Text\.StyledText/.test(src),
      `${file} renders markup`)
    totalText += declared
  }
  // And the guard must actually be covering something.
  assert.ok(totalText >= 5, `only ${totalText} Text blocks found; the guard is vacuous`)
})

test("no file has grown past the size it can be reviewed at", () => {
  // Two separate rules, one guard.
  //
  // For QML: logic there can only be reached by a test through a source
  // extractor, and every serious defect found in review has lived in exactly
  // that region -- so a QML file that is growing is usually growing logic.
  //
  // For lib/: these were one 739-line file, which is not a size anything gets
  // reviewed at properly. The split is the point, and nothing enforces it but
  // this.
  const budgets = {
    "Service.qml": 340, "Panel.qml": 280, "NodeRow.qml": 210, "ColumnWidths.qml": 140,
    "FleetIcon.qml": 110,
    "lib/Runtimes.js": 180, "lib/Text.js": 90, "lib/Servers.js": 110,
    "lib/Metrics.js": 230, "lib/Fleet.js": 320, "lib/Poll.js": 90,
    // Raised from 260 deliberately, not to silence the guard: the file took on
    // telling probe FAILURES apart -- no curl on this machine, versus a server
    // that accepted the connection and said nothing. Splitting it would put the
    // script that writes the markers in one file and the parser that reads them
    // in another, which is one protocol in two halves.
    "lib/Probe.js": 285, "lib/Reading.js": 120,
  }
  for (const [file, max] of Object.entries(budgets)) {
    const n = sourceOf(file).trimEnd().split("\n").length
    assert.ok(n <= max, `${file} is ${n} lines, over its ${max}-line budget — split it`)
  }

  // Every module has to be covered, or a new one grows unwatched.
  for (const f of fs.readdirSync(path.join(__dirname, "..", "lib"))) {
    assert.ok(budgets["lib/" + f] !== undefined, `lib/${f} has no line budget`)
  }
})

test("every lib module declares the dependencies it uses, and no others", () => {
  // The modules are QML JavaScript resources: they reach each other through
  // `.import`, and QML resolves that at load time, so a missing one is a
  // runtime failure in the shell rather than anything a test would see. An
  // unused one is the opposite problem -- it says a dependency exists that
  // does not, which is how a split silently grows back together.
  const dir = path.join(__dirname, "..", "lib")
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"))
  const owner = new Map()
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8")
    for (const m of src.matchAll(/^(?:function (\w+)|var (\w+))/gm)) {
      owner.set(m[1] || m[2], f.replace(/\.js$/, ""))
    }
  }
  for (const f of files) {
    const ns = f.replace(/\.js$/, "")
    const src = fs.readFileSync(path.join(dir, f), "utf8")
    assert.ok(/^\.pragma library$/m.test(src),
      `lib/${f} is not a library, so every QML file gets its own copy of it`)
    const declared = new Set([...src.matchAll(/^\.import "(\w+)\.js"/gm)].map(m => m[1]))
    // Comments are prose and may name anything; only code counts.
    const code = codeLines(src)
    const used = new Set()
    for (const [name, home] of owner) {
      if (home === ns) continue
      assert.ok(!new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(code),
        `lib/${f} uses ${home}.${name} unqualified`)
      if (new RegExp(`(?<![\\w$])${home}\\.${name}(?![\\w$])`).test(code)) used.add(home)
    }
    for (const u of used) assert.ok(declared.has(u), `lib/${f} uses ${u} without importing it`)
    for (const d of declared) assert.ok(used.has(d), `lib/${f} imports ${d} and never uses it`)
  }
})

test("the row does not measure for itself", () => {
  // Every row is handed identical widths so the columns line up. A row that
  // measured would drift the moment two nicknames differed in length.
  const row = codeOf("NodeRow.qml")
  assert.ok(!/TextMetrics/.test(row), "NodeRow measures text itself")
  assert.ok(!/\broot\./.test(row), "NodeRow still reaches into a parent by id")
  for (const p of ["labelWidth", "hostWidth", "runtimeWidth", "stateWidth", "rowContentWidth"]) {
    assert.ok(new RegExp("property real " + p).test(row), `NodeRow does not take ${p}`)
  }
})

test("the panel publishes every verb the base Panel does", () => {
  // Replacing the base handler quietly dropped show and hide, which every
  // shipped plugin has.
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const base = fs.readFileSync("/usr/share/omarchy/shell/Ui/Panel.qml", "utf8")
  const verbs = (src) => new Set((src.match(/function (\w+)\(\): void/g) || [])
    .map(m => m.match(/function (\w+)/)[1]))
  const ours = verbs(panel), theirs = verbs(base)
  for (const v of theirs) {
    assert.ok(ours.has(v), `the base Panel publishes ${v}() and this one does not`)
  }
})

test("every width the row declares is both used by it and wired by the panel", () => {
  // Asserting that the pieces EXIST is not asserting they are connected --
  // exactly the shape of the clampField defect, where both halves of the
  // wiring were tested and the function joining them was not. Setting
  // `width: labelWidth` to a literal, or `labelWidth: widths.label` to 0, both
  // passed a suite that checked the properties were declared.
  const row = fs.readFileSync(path.join(__dirname, "..", "NodeRow.qml"), "utf8")
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

  const declared = [...row.matchAll(/property real (\w+)/g)].map(m => m[1])
  assert.ok(declared.length >= 5, `expected the width properties, saw ${declared}`)

  for (const p of declared) {
    // Used for something, not merely declared.
    const uses = [...row.matchAll(new RegExp("\\b" + p + "\\b", "g"))].length
    assert.ok(uses >= 2, `NodeRow declares ${p} and never uses it`)

    // And the panel must hand it a real measurement, not a literal.
    const wired = panel.match(new RegExp(p + ":\\s*([^\\n]+)"))
    assert.ok(wired, `Panel.qml never wires ${p}`)
    assert.ok(/widths\./.test(wired[1]),
      `Panel.qml wires ${p} to ${wired[1].trim()} instead of a measured width`)
  }
})

test("the row's own columns are bound to the widths it was given", () => {
  // The four column Texts must take their width from the passed-in property.
  const row = fs.readFileSync(path.join(__dirname, "..", "NodeRow.qml"), "utf8")
  for (const p of ["labelWidth", "hostWidth", "runtimeWidth", "stateWidth"]) {
    assert.ok(new RegExp("width:\\s*" + p + "\\b").test(row),
      `no column is sized by ${p}`)
  }
  // And no column may carry a hardcoded pixel width.
  const literals = [...row.matchAll(/width:\s*(\d+)\s*$/gm)].map(m => m[1])
  assert.deepEqual(literals, [], `hardcoded column widths: ${literals}`)
})

test("the panel's second line explains what its headline just said", () => {
  // Evaluated, not read: this is a chain of conditions in a QML binding, and
  // the last review round found exactly that shape wrong twice. The order is
  // the whole content -- several of these are true at once, and the first one
  // that fires is the one the user is shown.
  const node = (over) => Object.assign(
    Fleet.blankNode("192.0.2.10", "n", {}), { read: true, reachable: true }, over || {})

  assert.equal(runPanelDetail({ configured: false }),
    "Add server addresses in the widget settings")

  // A rejected address outranks everything: a typo used to shorten the fleet
  // with nothing on screen to say why.
  assert.equal(runPanelDetail({ configError: "Ignoring an unusable address: x|y" }),
    "Ignoring an unusable address: x|y")

  // A missing curl must come BEFORE the reachability line, which is also true
  // here -- nothing was ever asked, so blaming the servers is a false claim
  // about them and hides the one thing the user can fix.
  const noTool = node({ reachable: false, probeTool: false })
  assert.equal(runPanelDetail({ nodes: [noTool, noTool] }),
    "Every server is probed with curl — install it to use this widget")

  // With curl present, an all-down fleet does report how many it asked.
  assert.equal(runPanelDetail({ nodes: [node({ reachable: false })] }),
    "Checked 1 address")
  assert.equal(runPanelDetail({ nodes: [node({ reachable: false }), node({ reachable: false })] }),
    "Checked 2 addresses")

  // Then the baseline, then the count that cannot report, then nothing.
  assert.equal(runPanelDetail({ nodes: [node({ firstReading: true })] }),
    "Establishing a baseline to compare against")
  assert.equal(runPanelDetail({ nodes: [node({ canReportActivity: false })] }),
    "1 server cannot report activity")
  assert.equal(runPanelDetail({ nodes: [node({ canReportActivity: false }), node({ canReportActivity: false })] }),
    "2 servers cannot report activity")
  assert.equal(runPanelDetail({ nodes: [node()] }), "")
})
