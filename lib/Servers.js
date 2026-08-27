.pragma library
.import "Text.js" as Text

// The `servers` setting, turned into a list this plugin is willing to probe.
//
// The output of this file is interpolated into a shell command, so isSafeHost
// is the boundary: anything that could end an argument or start another
// command must be impossible to express. A rejected entry is REPORTED rather
// than dropped -- a typo used to shorten the fleet silently.

// Parse the `servers` setting into { host, label } pairs.
//
// `10.0.0.5 = DGX Spark, gpu.local:8000` -- an entry may name its host, or be
// a bare host as before. The entry separator is the COMMA, because a nickname
// may contain spaces; a bare entry is additionally split on whitespace so the
// older "a b" form keeps working. A hostname cannot contain "=", so the split
// is unambiguous.
function parseServers(raw) {
  var out = []
  var entries = String(raw || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].trim()
    if (entry === "") continue
    var eq = entry.indexOf("=")
    if (eq === -1) {
      var bare = entry.split(/\s+/)
      for (var j = 0; j < bare.length; j++) {
        if (bare[j] !== "") out.push({ host: bare[j], label: "" })
      }
      continue
    }
    var host = entry.slice(0, eq).trim()
    // Only the FIRST "=" splits, so a nickname may contain one.
    var label = Text.stripLabel(entry.slice(eq + 1))
    if (host !== "") out.push({ host: host, label: label })
  }
  return out
}

// Split "host" or "host:port" into its parts.
//
// The settings label, the manifest schema and the panel's own help text all
// advertise `host:port` -- and it never worked. Discovery appended its port
// sweep to whatever it was given, so a configured "gpu.local:8000" was probed
// as "http://gpu.local:8000:8000/metrics" and every such node reported
// unreachable, with nothing to say why.
function splitHostPort(spec) {
  var text = String(spec || "")
  var at = text.lastIndexOf(":")
  if (at === -1) return { host: text, port: null }
  var port = text.slice(at + 1)
  if (!/^[0-9]{1,5}$/.test(port)) return { host: text, port: null }
  return { host: text.slice(0, at), port: parseInt(port, 10) }
}

// A host:port accepted into a shell command. Deliberately strict: this string
// is interpolated into a curl invocation, so anything that could end the
// argument or start another command must be impossible.
function isSafeHost(host) {
  var text = String(host || "")
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$/.test(text)) return false
  // {1,5} digits reaches 99999, above the 65535 splitHostPort clamps to -- so
  // `host:99999` was accepted here, probed as a URL no server can answer, and
  // reported "unreachable" rather than rejected with the config error the user
  // needed to see.
  var addr = splitHostPort(text)
  return addr.port === null || (addr.port >= 1 && addr.port <= 65535)
}
