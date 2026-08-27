.pragma library
.import "Runtimes.js" as Runtimes
.import "Servers.js" as Servers

// Building the probe command, and reading what it prints back.
//
// Pure string work, so every line is testable from node without a shell.

// How long one request may take, and how many a script may make. The kill
// timer wrapping the script is DERIVED from these rather than written beside
// them: kept as two independent numbers they disagreed, and a sweep was killed
// a fifth of the way through while the host was serving.
var KNOWN_MAX_TIME = 4
var DISCOVERY_MAX_TIME = 2      // 15 requests, so each must be cheap
var CONNECT_TIMEOUT = 1         // a filtered port hangs here, not at max-time
var ENDPOINTS_PER_PORT = 3      // /metrics, /api/ps, /v1/models
var SLACK_SEC = 3               // process start, grep, the shell itself

// Every branch redirects curl's stderr to /dev/null, so a missing curl is
// silent and looks exactly like a dead host. The manifest declares no
// dependency, so this is the only place it can be caught.
var NO_CURL = "command -v curl >/dev/null 2>&1 || { echo NOTOOL; exit 0; }\n"

// Why a probe came back with nothing readable, when it says.
//
// Only consulted once parse() has found no reading at all, so a server cannot
// forge these to describe itself: the worst it achieves is a differently
// worded FAILURE, never a claim that something is healthy.
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
  // -f so a non-2xx yields an EMPTY body: Ollama serves a "404 page not found"
  // PAGE at /metrics, and without -f discovery accepts it as metrics and never
  // reaches /api/ps.
  var n = Runtimes.MAX_PROBE_BYTES
  var known2xx = known && known.port && known.runtime
  var maxTime = known2xx ? KNOWN_MAX_TIME : DISCOVERY_MAX_TIME
  // --connect-timeout because a DROP-policy firewall hangs at CONNECT, where
  // --max-time is not what binds. It is what keeps a fifteen-port sweep against
  // a filtered host inside its budget.
  var curl = "curl -sSf --connect-timeout " + CONNECT_TIMEOUT + " --max-time " + maxTime
  // The liveness check deliberately DROPS -f. Its question is "did anything
  // answer", not "did it answer usefully" -- and -f turns every non-2xx into an
  // empty reply, which is what a dead host produces. With it, a vLLM behind an
  // auth proxy is indistinguishable from a box that lost power. --head because
  // a body we have decided not to read is bytes we do not need.
  var alive = "curl -sS --head --connect-timeout " + CONNECT_TIMEOUT +
              " --max-time " + maxTime
  var prefixes = []
  for (var key in Runtimes.RUNTIMES) {
    if (Runtimes.RUNTIMES[key].detect) prefixes.push(Runtimes.RUNTIMES[key].detect)
  }
  // No escaping needed: every prefix is a literal from the RUNTIMES table and
  // is matched against /^[A-Za-z0-9_:]+$/ below. Validate, do not "sanitise".
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
    // A cached runtime with no adapter: possible after an upgrade, since the
    // name comes from _state. An empty script yields an empty reply, and
    // Reading drops the stale entry so discovery starts over.
    if (!rt) return ""
    // QUOTED, like the sweep below. isSafeHost and the port clamp make it safe
    // already, but that is an argument about two other functions and this is
    // the string that reaches a shell.
    var url = "\"http://" + addr.host + ":" + known.port + rt.probe + "\""
    // 2>/dev/null like every curl here: -sS keeps error text, $(...) captures
    // only stdout, so otherwise it escapes to a stderr nobody reads.
    var cmd = curl + " " + url + " 2>/dev/null"
    if (rt.filter) cmd += " | grep -E '" + rt.filter + "'"
    // head closes the pipe, so a server streaming matching series forever is
    // cut off rather than absorbed. This is the path that runs on every poll.
    cmd += " | head -c " + Runtimes.MAX_PROBE_BYTES
    // The markers are emitted ONLY inside a branch that already proved
    // something answered. Echoed unconditionally they parse as a perfectly good
    // reading, and every failure of a known node is then drawn green "idle".
    //
    // Four outcomes, kept distinct:
    //   a filtered body -> reachable, with a sample
    //   NOSAMPLE        -> answered, but published nothing we can read
    //   NOANSWER        -> the TCP connection was accepted and then nothing
    //   nothing at all  -> down
    // The second costs a second request, and only when the first found nothing.
    // The third is free: it reads the connect time off that same request.
    //
    // NOANSWER separates a WEDGED server from a powered-off one, which both
    // time out. Measured: accepted-then-silent gives curl exit 28 with a
    // non-zero %{time_connect}; a refused port gives exit 7 and 0.000000, a
    // dropped packet exit 28 and 0.000000. Matched as "contains a digit 1-9"
    // rather than compared against "0.000000", whose format is not worth
    // trusting across locales.
    var markers = "echo \"PORT " + known.port + "\"; echo \"RT " + known.runtime + "\""
    return "{\n" +
           NO_CURL +
           "b=$(" + cmd + ")\n" +
           "if [ -n \"$b\" ]; then\n" +
           "  " + markers + "\n" +
           "  printf '%s' \"$b\"\n" +
           "else\n" +
           // Capturing the connect time also keeps this curl's stdout out of
           // the script's own output, where an error page would be parsed as
           // the node's body.
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

  // GREP FIRST, head second. A real vLLM /metrics is ~68 kB and publishes
  // num_requests_running at byte 6343 and generation_tokens_total at 13535, so
  // bounding the raw body cuts off everything worth reading while detection
  // still succeeds -- reachable and permanently idle, with no error anywhere.
  // head still closes the pipe, so a hostile endpoint cannot stream forever.
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
  // ONE choke point on the whole script's output, not a bound per branch: a
  // new branch inherits this, where a per-branch ceiling has to be remembered.
  return "{\n" + NO_CURL + lines.join("\n") + "\n} | head -c " + n
}


// Split what the probe printed into its parts.
//
// The PORT and RT markers are echoed by the script itself and precede the
// body, so a first-match search cannot be forged by a server: its bytes arrive
// after ours.
function parse(text, maxBytes) {
  // The ceiling belongs to the probe rather than the caller: it is a property
  // of the shell boundary this file owns.
  var raw = String(text || "")
  var limit = maxBytes || Runtimes.MAX_PROBE_BYTES
  var clipped = raw.slice(0, limit)
  // At the ceiling the last line was cut mid-number, and a truncated counter
  // reads LOWER -- so the next untruncated poll looks like a large positive
  // delta and renders as tokens nobody generated. The markers are at the top,
  // so dropping the partial line risks nothing that identifies the node.
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
  // NOSAMPLE is not reported as a field: the caller decides by whether a sample
  // could be READ, which also covers what a marker cannot see -- a body that
  // merely prefix-matches the filter, or a cached port now serving something
  // else. The marker stays because it is what makes the text non-empty here,
  // and so the difference between "alive but quiet" and "did not answer".
  return { runtime: runtime, port: port, body: body }
}
