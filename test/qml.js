// Reaching into QML from a test.
//
// Nothing here is a good idea in isolation -- it parses a language with a
// regex and a brace counter. It exists because QML cannot be loaded by
// `node --test`, and the alternative was leaving the wiring between the panel,
// its rows and the service unasserted entirely. Anything that can be moved
// into lib/ and executed IS, and that migration is most of what the last two
// review rounds produced; what is left are the parts that are irreducibly QML.

const assert = require("node:assert")
const { Servers, Text, sourceOf } = require("./harness.js")

const SERVICE = sourceOf("Service.qml")

// Brace-matching that is aware of strings, comments AND regex literals. The
// comment case is not decoration: an apostrophe in a comment reads as an
// unterminated string, and the extractor then swallows the rest of the file.
function extractFunction(name) {
  const src = SERVICE.slice(SERVICE.indexOf("function " + name))
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
  return src.slice(0, i)
}

function runConfiguredServers(setting) {
  // The REAL binding body, so this cannot drift from what the plugin does.
  // The parsing moved from a function into the `configured` property, so the
  // extractor takes the property's expression block rather than a function.
  const at = SERVICE.indexOf("readonly property var configured:")
  assert.notEqual(at, -1, "the configured property could not be found")
  const src = SERVICE.slice(at)
  let depth = 0, i = src.indexOf("{"), seen = false
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === "/" && n === "/") { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl; continue }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "/") { i++; while (i < src.length && src[i] !== "/") i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "{") { depth++; seen = true }
    else if (c === "}") { depth--; if (seen && depth === 0) { i++; break } }
    i++
  }
  const body = src.slice(src.indexOf("{"), i)
  const self = { serversSetting: setting, Servers, Text }
  return new Function("self", `with (self) { return (function() ${body})() }`)(self).servers
}

function runConfiguredRejects(setting) {
  const at = SERVICE.indexOf("readonly property var configured:")
  const src = SERVICE.slice(at)
  let depth = 0, i = src.indexOf("{"), seen = false
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === "/" && n === "/") { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl; continue }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "/") { i++; while (i < src.length && src[i] !== "/") i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "{") { depth++; seen = true }
    else if (c === "}") { depth--; if (seen && depth === 0) { i++; break } }
    i++
  }
  const body = src.slice(src.indexOf("{"), i)
  const self = { serversSetting: setting, Servers, Text }
  return new Function("self", `with (self) { return (function() ${body})() }`)(self).rejected
}

module.exports = { SERVICE, extractFunction, runConfiguredServers, runConfiguredRejects }
