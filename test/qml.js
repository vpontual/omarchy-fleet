// Reaching into QML from a test.
//
// Nothing here is a good idea in isolation -- it parses a language with a
// brace counter. It exists because QML cannot be loaded by `node --test`, and
// the alternative was leaving the wiring between the panel, its rows and the
// service unasserted entirely. Anything that can be moved into lib/ and
// executed IS, and that migration is most of what the last two review rounds
// produced; what is left are the parts that are irreducibly QML.

const assert = require("node:assert")
const { Servers, Text, Fleet, sourceOf } = require("./harness.js")

const SERVICE = sourceOf("Service.qml")
const PANEL = sourceOf("Panel.qml")
const NODEROW = sourceOf("NodeRow.qml")

// The block that follows a marker, brace-matched.
//
// Aware of strings, comments AND regex literals. The comment case is not
// decoration: an apostrophe inside one reads as an unterminated string, and
// the extractor then swallows the rest of the file.
function blockAfter(source, marker, what) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `${what} could not be found`)
  const src = source.slice(at)
  let depth = 0, i = src.indexOf("{"), seen = false
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === "/" && n === "/") { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl; continue }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? src.length : e + 2; continue }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "/") { i++; while (i < src.length && src[i] !== "/") i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "{") { depth++; seen = true }
    else if (c === "}") { depth--; if (seen && depth === 0) { i++; break } }
    i++
  }
  return { whole: src.slice(0, i), body: src.slice(src.indexOf("{"), i) }
}

function extractFunction(name) {
  return blockAfter(SERVICE, "function " + name, `Service.qml's ${name}()`).whole
}

// Evaluate a QML property's expression block with `self` supplying everything
// it reaches for. The REAL binding body, so a test cannot drift from what the
// plugin does -- which is the entire reason for the machinery above.
function runBinding(source, marker, what, self) {
  const { body } = blockAfter(source, marker, what)
  return new Function("self", `with (self) { return (function() ${body})() }`)(self)
}

// The `servers` setting, parsed by Service.qml's own `configured` binding.
function runConfigured(setting) {
  return runBinding(SERVICE, "readonly property var configured:",
    "the configured property", { serversSetting: setting, Servers, Text })
}
function runConfiguredServers(setting) { return runConfigured(setting).servers }
function runConfiguredRejects(setting) { return runConfigured(setting).rejected }

// The panel's second line, which explains whatever the headline just said.
// `fleet` here stands in for the Service; only what the binding reads matters.
function runPanelDetail(state) {
  const fleetState = Fleet.fleetState(state.nodes || [])
  const self = {
    Fleet: Fleet,
    configured: state.configured !== false,
    nothingReachable: Fleet.nothingReachable(fleetState, state.configured !== false),
    fleet: {
      configError: state.configError || "",
      // DERIVED from the rows, as Service.qml derives it. Hardcoding it here
      // would have made the baseline branch below untestable while looking
      // tested, which is the failure mode this whole file exists to avoid.
      baselineReady: state.baselineReady !== undefined
        ? state.baselineReady : Fleet.baselineReady(state.nodes || []),
      fleet: fleetState,
    },
  }
  return runBinding(PANEL, "readonly property string detail:", "the detail property", self)
}

// The row's traffic light. Colours come back as the NAMES of the theme slots
// rather than real colours, so a test can assert that distinct states are
// distinct things without hard-coding a palette.
//
// Evaluated, not read: a chain of returns inside a QML property is exactly
// where the previous rounds' defects lived, and four mutations of this one --
// including drawing an unreachable server GREEN -- passed the whole suite.
function runNodeRowColor(node) {
  return runBinding(NODEROW, "readonly property color stateColor:", "stateColor", {
    Fleet: Fleet, node: node,
    urgent: "urgent", dim: "dim",
    nodeRow: { amber: "amber", green: "green" },
  })
}

// The row's quieter second line: model, in-flight, queued, cache pressure.
function runNodeRowDetail(node) {
  return runBinding(NODEROW, "readonly property string detailText:", "detailText", {
    Fleet: Fleet, Text: Text, node: node, Math: Math,
  })
}

module.exports = {
  SERVICE, PANEL, NODEROW, extractFunction,
  runConfiguredServers, runConfiguredRejects, runPanelDetail,
  runNodeRowColor, runNodeRowDetail,
}
