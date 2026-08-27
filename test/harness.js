// Loads the plugin's lib/ modules the way QML does, for `node --test`.
//
// The modules are QML JavaScript resources: each declares `.pragma library`
// and pulls its dependencies in with `.import "Other.js" as Other`. Neither
// directive is valid JavaScript, so they cannot simply be `require`d -- but
// they are the whole reason the modules can be split at all, and a test suite
// that could not see across them would be testing a different program.
//
// So this reads each file, lifts the directives off, resolves them into a load
// order, and evaluates each module with its dependencies bound to the same
// names QML binds them to. Exports are DISCOVERED from the source rather than
// listed here: a hand-maintained list is one more thing to forget, and it was
// forgotten twice.
//
// What this cannot check is that a QML file imports every module it uses --
// only a real shell proves that, which is why the plugin is loaded into one
// before any change is believed.

const fs = require("node:fs")
const path = require("node:path")

const LIB = path.join(__dirname, "..", "lib")

function read(name) {
  return fs.readFileSync(path.join(LIB, name + ".js"), "utf8")
}

// The `.import` lines of one module, in the order QML would see them.
function dependenciesOf(source) {
  return [...source.matchAll(/^\.import\s+"(\w+)\.js"\s+as\s+(\w+)\s*$/gm)]
    .map(m => ({ file: m[1], as: m[2] }))
}

// Every top-level declaration. QML exposes all of them through the namespace,
// so the test harness does too -- including the ones a module would rather
// keep to itself, which is a fair reflection of what QML actually offers.
function exportsOf(source) {
  return [...source.matchAll(/^(?:function (\w+)|var (\w+))/gm)]
    .map(m => m[1] || m[2])
}

const loaded = new Map()
const loading = new Set()

function load(name) {
  if (loaded.has(name)) return loaded.get(name)
  if (loading.has(name)) throw new Error(`circular import through ${name}.js`)
  loading.add(name)

  const source = read(name)
  const deps = dependenciesOf(source)
  const values = deps.map(d => load(d.file))
  const names = exportsOf(source)
  // Strip the QML-only directives; everything below them is plain JavaScript.
  const body = source.replace(/^\.(pragma|import)[^\n]*$/gm, "")

  const build = new Function(...deps.map(d => d.as),
    `${body}\n; return { ${names.join(", ")} }`)
  const module = build(...values)

  loading.delete(name)
  loaded.set(name, module)
  return module
}

const Runtimes = load("Runtimes")
const Text = load("Text")
const Servers = load("Servers")
const Metrics = load("Metrics")
const Fleet = load("Fleet")
const Poll = load("Poll")
const Probe = load("Probe")
const Reading = load("Reading")

// Source text, for the handful of assertions that can only be made about QML.
// Comments are stripped first: `extractFunction` returns them too, and an
// assertion matching source can otherwise pass against the comment that
// explains why the code it is checking for exists.
function sourceOf(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8")
}
function codeLines(text) {
  return text.split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
}
function codeOf(file) {
  return codeLines(sourceOf(file))
}

// One probe result through the real assembler, exactly as Service._record
// calls it. Thin on purpose: the honesty rules being tested are in Reading.js,
// and a helper that reshaped the arguments would be testing itself.
function readingOf(out, prev, host) {
  return Reading.apply(host || "192.0.2.10", "node", out, prev, 1000)
}

// The REAL probe script, built rather than scraped out of QML.
function renderProbe(host, known) {
  return Probe.script(host, known)
}

module.exports = {
  Runtimes, Text, Servers, Metrics, Fleet, Poll, Probe, Reading,
  sourceOf, codeOf, codeLines, readingOf, renderProbe, LIB,
}
