// Building the probe command, and reading what it prints back.
//
// Pure string work: no QML types, and Model is passed in rather than imported,
// so every line here is directly testable from plain node without a running
// shell. It used to live in Service.qml, where the test suite could only reach
// it through a hand-rolled brace-matching source extractor -- four of them, in
// fact, one of which had already produced assertions that matched a COMMENT
// rather than the code. Both of the plugin's blocking defects were found in
// exactly that unreachable region.

function script(Model, host, known) {
  // -f so a non-2xx yields an EMPTY body. Without it, Ollama's own
  // "404 page not found" page at /metrics is a non-empty body, which made
  // discovery accept the metrics branch and never reach /api/ps -- the node
  // then reported as unreachable. Measured against a real Ollama server.
  // Declared before any branch: the known-node path returns early, and it
  // rendered "head -c undefined" while this sat further down.
  var n = Model.MAX_PROBE_BYTES
  var curl = "curl -sSf --max-time 4"
  var prefixes = []
  for (var key in Model.RUNTIMES) {
    if (Model.RUNTIMES[key].detect) prefixes.push(Model.RUNTIMES[key].detect)
  }
  // No escaping here, and none needed: every prefix is a literal from the
  // RUNTIMES table, matched against /^[A-Za-z0-9_:]+$/ below. There used to
  // be a `.replace(/:/g, ":")` in this line, which replaced a colon with a
  // colon -- a no-op wearing the costume of a sanitiser.
  for (var pi = 0; pi < prefixes.length; pi++) {
    if (!/^[A-Za-z0-9_:]+$/.test(String(prefixes[pi]))) {
      log("refusing a malformed runtime prefix: " + prefixes[pi])
      return ""
    }
  }
  var isMetrics = "grep -qE '^(" + prefixes.join("|") + ")'"

  // An explicitly configured port is authoritative: probe THAT, never sweep.
  var addr = Model.splitHostPort(host)

  if (known && known.port) {
    var rt = Model.runtimeOf(known.runtime)
    var url = "http://" + addr.host + ":" + known.port + rt.probe
    var cmd = curl + " " + url
    if (rt.filter) cmd += " | grep -E '" + rt.filter + "'"
    // The steady-state path, and it was the UNBOUNDED one: discovery capped
    // its body while this, which runs on every poll once a node is known,
    // piped straight into the collector. head closes the pipe, so a server
    // streaming matching series forever is cut off rather than absorbed.
    cmd += " | head -c " + Model.MAX_PROBE_BYTES
    return "{ echo \"PORT " + known.port + "\"; echo \"RT " + known.runtime + "\"; " + cmd +
           "\n} | head -c " + n
  }

  // Keep ONLY the series any runtime actually reads, then bound what is
  // left. Bounding the raw body instead was the bug that made this plugin
  // useless: a real vLLM /metrics is ~68 kB and publishes
  // num_requests_running at byte 6343 and generation_tokens_total at 13535,
  // so `head -c 4000` cut both off. Detection still succeeded -- the `vllm:`
  // prefix appears early -- so the node reported reachable while readSample
  // returned null. And because the sample was null the discovered port was
  // never cached, so every later poll re-ran discovery and truncated again.
  // Permanently reachable, permanently idle, no error anywhere.
  //
  // grep first, head second: the filter output is a handful of lines, and
  // head still closes the pipe so a hostile endpoint cannot stream forever.
  var unionFilter = []
  for (var rk in Model.RUNTIMES) {
    var rf = Model.RUNTIMES[rk].filter
    if (rf) unionFilter.push(rf.replace(/^\^/, ""))
  }
  var keep = "grep -E '^(" + unionFilter.join("|") + ")'"

  // With a port given, the sweep is a single candidate -- and the address
  // used to build the URL is the host WITHOUT it.
  var candidates = addr.port ? [addr.port] : Model.PORT_CANDIDATES

  var lines = []
  lines.push("for p in " + candidates.join(" ") + "; do")
  lines.push("  b=$(" + curl + " \"http://" + addr.host + ":$p/metrics\" 2>/dev/null | " + keep + " | head -c " + Model.MAX_PROBE_BYTES + ")")
  // Only a body that actually carries a known series prefix counts as
  // metrics; anything else falls through to the next probe.
  lines.push("  if printf '%s' \"$b\" | " + isMetrics + "; then echo \"PORT $p\"; echo \"BODY\"; printf '%s' \"$b\"; exit 0; fi")
  lines.push("  b=$(" + curl + " \"http://" + addr.host + ":$p/api/ps\" 2>/dev/null | head -c " + n + ")")
  lines.push("  case \"$b\" in *'\"models\"'*) echo \"PORT $p\"; echo \"RT ollama\"; printf '%s' \"$b\"; exit 0;; esac")
  lines.push("  b=$(" + curl + " \"http://" + addr.host + ":$p/v1/models\" 2>/dev/null | head -c " + n + ")")
  lines.push("  case \"$b\" in *'\"data\"'*) echo \"PORT $p\"; echo \"RT openai\"; exit 0;; esac")
  lines.push("done")
  // A single choke point on the whole script's output, not a bound per
  // branch. Two of the three discovery branches shipped with no ceiling at
  // all -- `/api/ps` printed an entirely unfiltered body straight to stdout
  // -- and the per-branch approach is what let that happen: a new branch
  // inherits nothing. Wrapping the script means no branch, present or
  // future, can write more than the ceiling however it is written.
  return "{\n" + lines.join("\n") + "\n} | head -c " + n
}


// Split what the probe printed into its parts.
//
// The PORT and RT markers are echoed by the script itself and precede the
// body, so a first-match search cannot be forged by a server: its bytes arrive
// after ours.
function parse(Model, text, maxBytes) {
  var clipped = String(text || "").slice(0, maxBytes)
  if (clipped.replace(/\s/g, "") === "") return null

  var portMatch = clipped.match(/^PORT (\d+)$/m)
  var rtMatch = clipped.match(/^RT ([a-z]+)$/m)
  var body = clipped.replace(/^PORT \d+$/m, "")
                    .replace(/^RT [a-z]+$/m, "")
                    .replace(/^BODY$/m, "")

  var runtime = rtMatch ? rtMatch[1] : Model.detectFromMetrics(body)
  if (!runtime) return null

  // Clamped to a real port. parseInt on unbounded digits stringifies as
  // "1e+30" straight back into the next URL.
  var port = null
  if (portMatch) {
    var n = parseInt(portMatch[1], 10)
    if (n >= 1 && n <= 65535) port = n
  }
  return { runtime: runtime, port: port, body: body }
}
