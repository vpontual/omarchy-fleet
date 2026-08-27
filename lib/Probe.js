.pragma library
.import "Runtimes.js" as Runtimes
.import "Servers.js" as Servers

// Building the probe command, and reading what it prints back.
//
// Pure string work: no QML types, and Model is passed in rather than imported,
// so every line here is directly testable from plain node without a running
// shell. It used to live in Service.qml, where the test suite could only reach
// it through a hand-rolled brace-matching source extractor -- four of them, in
// fact, one of which had already produced assertions that matched a COMMENT
// rather than the code. Both of the plugin's blocking defects were found in
// exactly that unreachable region.

// How long one request may take, and how many a script may make.
//
// These two facts have to agree with the kill timer wrapping the script, and
// for a while they did not: discovery made fifteen requests at four seconds
// each -- sixty seconds of budget -- under a twelve-second
// `timeout --signal=KILL`. Measured, with one unresponsive port ahead of a
// live one, the sweep was killed at 12.006s having never reached the second
// port. Any host not answering promptly on 8000 could not be discovered AT
// ALL, and was drawn "unreachable" while serving. The README advertised both
// numbers in adjacent sentences without noticing.
//
// So the budget is now DERIVED from the script rather than written beside it,
// and a test asserts the derivation covers the worst case.
var KNOWN_MAX_TIME = 4
var DISCOVERY_MAX_TIME = 2      // 15 requests, so each must be cheap
var CONNECT_TIMEOUT = 1         // a filtered port hangs here, not at max-time
var ENDPOINTS_PER_PORT = 3      // /metrics, /api/ps, /v1/models
var SLACK_SEC = 3               // process start, grep, the shell itself

// Every branch below redirects curl's stderr to /dev/null, so a missing curl
// printed "command not found" where nobody could see it and produced exactly
// what a dead host produces: the whole fleet drawn "unreachable", with the
// real cause -- one missing package on THIS machine -- invisible. The manifest
// declares no dependency, so this is the only place it can be caught.
var NO_CURL = "command -v curl >/dev/null 2>&1 || { echo NOTOOL; exit 0; }\n"

// Why a probe came back with nothing readable, when it says.
//
// Only consulted once parse() has found no reading at all, so a server cannot
// use these words to describe itself: by then nothing it sent parsed. The
// worst a forged marker achieves is a differently-worded failure -- never a
// claim that anything is healthy.
function failure(text) {
  var clipped = String(text || "").slice(0, Runtimes.MAX_PROBE_BYTES)
  if (/^NOTOOL$/m.test(clipped)) return "notool"
  if (/^NOANSWER$/m.test(clipped)) return "noanswer"
  return null
}

// Requests this script can make, worst case.
function _requests(host, known) {
  if (known && known.port && known.runtime) return 2   // read, then liveness
  var addr = Servers.splitHostPort(String(host || ""))
  var ports = addr.port ? 1 : Runtimes.PORT_CANDIDATES.length
  return ports * ENDPOINTS_PER_PORT
}

// The deadline to wrap this script in. Never smaller than what it can spend.
function budgetSec(host, known) {
  var perRequest = (known && known.port && known.runtime)
    ? KNOWN_MAX_TIME : DISCOVERY_MAX_TIME
  return _requests(host, known) * perRequest + SLACK_SEC
}

function script(host, known) {
  // -f so a non-2xx yields an EMPTY body. Without it, Ollama's own
  // "404 page not found" page at /metrics is a non-empty body, which made
  // discovery accept the metrics branch and never reach /api/ps -- the node
  // then reported as unreachable. Measured against a real Ollama server.
  // Declared before any branch: the known-node path returns early, and it
  // rendered "head -c undefined" while this sat further down.
  var n = Runtimes.MAX_PROBE_BYTES
  var known2xx = known && known.port && known.runtime
  var maxTime = known2xx ? KNOWN_MAX_TIME : DISCOVERY_MAX_TIME
  // --connect-timeout because a DROP-policy firewall hangs at connect, where
  // --max-time is not the binding constraint. It is what keeps a fifteen-port
  // sweep against a filtered host inside its budget.
  var curl = "curl -sSf --connect-timeout " + CONNECT_TIMEOUT + " --max-time " + maxTime
  // The liveness check deliberately drops -f. Its question is "did anything
  // answer", not "did it answer with a body worth reading" -- and -f turns
  // every non-2xx into an empty reply, which is exactly what a dead host
  // produces. So a vLLM behind an auth proxy (401), or one whose /metrics
  // 500s while the engine happily serves, was drawn urgent-red "unreachable",
  // indistinguishable from a box that lost power. --head because a body we
  // have already decided not to read is bytes we do not need.
  var alive = "curl -sS --head --connect-timeout " + CONNECT_TIMEOUT +
              " --max-time " + maxTime
  var prefixes = []
  for (var key in Runtimes.RUNTIMES) {
    if (Runtimes.RUNTIMES[key].detect) prefixes.push(Runtimes.RUNTIMES[key].detect)
  }
  // No escaping here, and none needed: every prefix is a literal from the
  // RUNTIMES table, matched against /^[A-Za-z0-9_:]+$/ below. There used to
  // be a `.replace(/:/g, ":")` in this line, which replaced a colon with a
  // colon -- a no-op wearing the costume of a sanitiser.
  for (var pi = 0; pi < prefixes.length; pi++) {
    if (!/^[A-Za-z0-9_:]+$/.test(String(prefixes[pi]))) {
      return ""
    }
  }
  var isMetrics = "grep -qE '^(" + prefixes.join("|") + ")'"

  // An explicitly configured port is authoritative: probe THAT, never sweep.
  var addr = Servers.splitHostPort(host)

  if (known && known.port) {
    var rt = Runtimes.runtimeOf(known.runtime)
    // A cached runtime with no adapter. Not reachable today -- the runtime name
    // is echoed by our own marker, so it can only be one this file wrote -- but
    // dereferencing null here would throw out of refresh() with `probing`
    // already true, and every later cycle returns early on it. Forever. An
    // empty script instead yields an empty reply and an honest "unreachable".
    if (!rt) return ""
    // QUOTED, like the discovery sweep below. isSafeHost and the port clamp
    // both hold, so this is safe today -- but that is an argument about two
    // other functions, and this is the string that reaches a shell.
    var url = "\"http://" + addr.host + ":" + known.port + rt.probe + "\""
    // 2>/dev/null like every other curl here: -sS keeps error text for a human
    // and $(...) captures stdout only, so without this it escapes to the
    // shell's stderr, which nothing collects and nobody reads.
    var cmd = curl + " " + url + " 2>/dev/null"
    if (rt.filter) cmd += " | grep -E '" + rt.filter + "'"
    // The steady-state path, and it was the UNBOUNDED one: discovery capped
    // its body while this, which runs on every poll once a node is known,
    // piped straight into the collector. head closes the pipe, so a server
    // streaming matching series forever is cut off rather than absorbed.
    cmd += " | head -c " + Runtimes.MAX_PROBE_BYTES
    // The markers are emitted ONLY after something answered.
    //
    // They used to be echoed unconditionally, before curl ran -- so every
    // failure of a known node (refused, timeout, DNS, 5xx, the kill timer
    // firing) still produced "PORT n\nRT vllm\n", which parses as a perfectly
    // good reading. The node was drawn idle, in green, forever: a box that lost
    // power was indistinguishable from a healthy quiet one, which is the single
    // question this plugin exists to answer.
    //
    // Discovery never had the bug because it echoes markers inside a branch
    // that already proved the endpoint answered. This is that shape. Three
    // outcomes, kept distinct:
    //   a filtered body -> reachable, with a sample
    //   NOSAMPLE        -> answered, but published nothing we can read
    //   NOANSWER        -> the TCP connection was accepted and then nothing
    //   nothing at all  -> down
    // The second costs an extra request, and only when the first found
    // nothing, so a healthy node is still one request. The third costs
    // nothing extra: it reads the connect time off that same request.
    //
    // NOANSWER is what distinguishes a WEDGED server from a powered-off one.
    // Both time out and both used to be drawn "unreachable" -- while the
    // README names "is it thinking, or did the server wedge?" as a question
    // this plugin answers. Measured: a server that accepts the connection and
    // never replies gives curl exit 28 with a non-zero %{time_connect}; a
    // refused port gives exit 7 and 0.000000, and a dropped packet gives
    // exit 28 and 0.000000. So a non-zero connect time IS the discriminator.
    // Matched as "contains a digit 1-9" rather than compared against
    // "0.000000", because the format of that field is not worth trusting
    // across locales.
    var markers = "echo \"PORT " + known.port + "\"; echo \"RT " + known.runtime + "\""
    return "{\n" +
           NO_CURL +
           "b=$(" + cmd + ")\n" +
           "if [ -n \"$b\" ]; then\n" +
           "  " + markers + "\n" +
           "  printf '%s' \"$b\"\n" +
           "else\n" +
           // The connect time is CAPTURED rather than discarded, which is also
           // what keeps this curl's stdout out of the script's own output: it
           // used to need >/dev/null for that, with -o /dev/null the only
           // thing standing between an error page and a forged sample.
           "  tc=$(" + alive + " -o /dev/null -w '%{time_connect}' " + url + " 2>/dev/null)\n" +
           "  if [ $? -eq 0 ]; then\n" +
           "    " + markers + "\n" +
           "    echo NOSAMPLE\n" +
           "  else\n" +
           "    case \"$tc\" in *[1-9]*) echo NOANSWER ;; esac\n" +
           "  fi\n" +
           "fi\n" +
           "} | head -c " + n
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
  for (var rk in Runtimes.RUNTIMES) {
    var rf = Runtimes.RUNTIMES[rk].filter
    if (rf) unionFilter.push(rf.replace(/^\^/, ""))
  }
  var keep = "grep -E '^(" + unionFilter.join("|") + ")'"

  // With a port given, the sweep is a single candidate -- and the address
  // used to build the URL is the host WITHOUT it.
  var candidates = addr.port ? [addr.port] : Runtimes.PORT_CANDIDATES

  var lines = []
  lines.push("for p in " + candidates.join(" ") + "; do")
  lines.push("  b=$(" + curl + " \"http://" + addr.host + ":$p/metrics\" 2>/dev/null | " + keep + " | head -c " + Runtimes.MAX_PROBE_BYTES + ")")
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
  return "{\n" + NO_CURL + lines.join("\n") + "\n} | head -c " + n
}


// Split what the probe printed into its parts.
//
// The PORT and RT markers are echoed by the script itself and precede the
// body, so a first-match search cannot be forged by a server: its bytes arrive
// after ours.
function parse(text, maxBytes) {
  // The ceiling belongs to the probe, not to the caller: it was threaded down
  // from Service.qml through every layer, so each one had to know a constant
  // that is really a property of the shell boundary this file owns.
  var raw = String(text || "")
  var limit = maxBytes || Runtimes.MAX_PROBE_BYTES
  var clipped = raw.slice(0, limit)
  // At the ceiling the last line was almost certainly cut mid-number, and a
  // truncated counter reads LOWER than the real one -- so the next poll's
  // untruncated read looks like a large positive delta and renders as tokens
  // that were never generated. Drop the partial line; the markers are at the
  // top, so nothing that identifies the node is at risk.
  if (raw.length >= limit) {
    var lastNewline = clipped.lastIndexOf("\n")
    clipped = lastNewline === -1 ? "" : clipped.slice(0, lastNewline + 1)
  }
  if (clipped.replace(/\s/g, "") === "") return null

  var portMatch = clipped.match(/^PORT (\d+)$/m)
  var rtMatch = clipped.match(/^RT ([a-z]+)$/m)
  var body = clipped.replace(/^PORT \d+$/m, "")
                    .replace(/^RT [a-z]+$/m, "")
                    .replace(/^BODY$/m, "")
                    .replace(/^NOSAMPLE$/m, "")
                    .replace(/^NOANSWER$/m, "")
                    .replace(/^NOTOOL$/m, "")

  var runtime = rtMatch ? rtMatch[1] : Runtimes.detectFromMetrics(body)
  if (!runtime) return null

  // Clamped to a real port. parseInt on unbounded digits stringifies as
  // "1e+30" straight back into the next URL.
  var port = null
  if (portMatch) {
    var n = parseInt(portMatch[1], 10)
    if (n >= 1 && n <= 65535) port = n
  }
  // No sampleless flag: the caller decides by whether a sample could be READ,
  // which covers this case and the ones a marker cannot see -- a body that
  // merely prefix-matches the filter, or a cached port now serving something
  // else. The marker itself stays because it is what makes the text non-empty
  // on that branch, and so the difference between "alive but quiet" and "did
  // not answer at all".
  return { runtime: runtime, port: port, body: body }
}
