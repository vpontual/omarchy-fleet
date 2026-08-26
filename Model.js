// Pure parsing and activity maths for the fleet widget. No QML types, so it
// can be tested with `node --test`.
//
// The widget is an ACTIVITY LIGHT, not a dashboard: the question it answers is
// "is anything actually doing work right now", the way a disk LED did. That
// single decision drives everything here.
//
// It also means the signal must be a COUNTER, not a gauge. A gauge like
// vllm:num_requests_running only shows work that happens to be in flight at
// the instant we sample, so a request that starts and finishes between two
// polls is invisible. A monotonic token counter still moves, so the light
// catches it. Verified against a live server: one 2-token completion moved
// vllm:generation_tokens_total from 48456 to 48458.

var PROBE_TIMEOUT_SEC = 12

// Hard ceiling on what any probe may hand back, applied in the shell BEFORE
// the bytes reach QML.
//
// Quickshell's StdioCollector has no size limit of its own -- its whole API is
// text/data/waitForEnd -- so whatever a probe emits is retained in full, in
// the process that draws the entire desktop bar. The filtered reply from a
// real vLLM node is ~478 bytes, so this is well over a hundred times the
// headroom it needs; it exists for the server that answers with 11 MB of well-formed
// matching series, not for the honest one. Measured: without it, exactly that
// much reached the collector, every 3 seconds.
var MAX_PROBE_BYTES = 65536

// ── Runtime adapters ──────────────────────────────────────────────────
//
// Adding a runtime should be a data change, not a code change. Each adapter
// says where to look and which series carries "work done so far".
//
// `probe` is the path to fetch. `filter` is an extended-regex handed to grep
// at the fetch boundary, because a vLLM /metrics body is ~68 kB and this
// runs inside the process that hosts the whole desktop -- the shell should
// never see the other 99.7%.
// Seconds before a whole probe is killed outright.
//
// `curl --max-time` bounds ONE request, and discovery can make fifteen: five
// candidate ports times three endpoints. A host that drops packets rather than
// refusing them therefore had no overall bound at all, and the 15s watchdog
// only resets the plugin's own flags -- the processes carry on. This bounds
// the whole sweep, and sits under that watchdog so it fires first.
var RUNTIMES = {
  vllm: {
    label: "vLLM", port: 8000, probe: "/metrics", detect: "vllm:",
    filter: "^vllm:(generation_tokens_total|num_requests_running|num_requests_waiting|kv_cache_usage_perc)",
    work: "vllm:generation_tokens_total",
    running: "vllm:num_requests_running",
    waiting: "vllm:num_requests_waiting",
    // Fraction 0..1 of the KV cache in use. The "is it struggling" signal:
    // near 1.0 means requests are about to be preempted rather than served.
    // vLLM only -- the others are left null rather than guessed at, matching
    // how `verified` is used throughout this table.
    cache: "vllm:kv_cache_usage_perc",
    // Run against a real vLLM node, under load, with the counter observed to
    // move. The only runtime here where activity has actually been watched.
    verified: "live"
  },  ollama: {
    label: "Ollama", port: 11434, probe: "/api/ps", detect: null,
    filter: null,
    // No metrics endpoint exists, so there is no token counter. What Ollama
    // does expose is each resident model's keep-alive expiry, pushed forward
    // on every use. Verified live: stable across a 6s idle gap, advanced on
    // the next request.
    //
    // Only the CHANGE is meaningful. The value is computed on the node's
    // clock -- observed 15 minutes ahead of this laptop -- so comparing it
    // against local time would be nonsense.
    work: null,
    verified: "live"
  },  llamacpp: {
    label: "llama.cpp", port: 8080, probe: "/metrics", detect: "llamacpp:",
    filter: "^llamacpp:(tokens_predicted_total|requests_processing|requests_deferred)",
    work: "llamacpp:tokens_predicted_total",
    running: "llamacpp:requests_processing",
    waiting: "llamacpp:requests_deferred",
    // llama-server only serves /metrics when started with --metrics.
    //
    // Names confirmed against upstream's OWN test suite
    // (tools/server/tests/unit/test_metrics.py), which asserts these exact
    // strings and their types: tokens_predicted_total is a counter,
    // requests_processing and requests_deferred are gauges. Never run here.
    verified: "names"
  },  tgi: {
    label: "TGI", port: 8080, probe: "/metrics", detect: "tgi_",
    filter: "^tgi_(request_generated_tokens_sum|batch_current_size|queue_size)",
    // A histogram, so the exposition emits _sum -- the monotonic total.
    work: "tgi_request_generated_tokens_sum",
    running: "tgi_batch_current_size",
    waiting: "tgi_queue_size",
    // Names confirmed against upstream router source and the metrics
    // reference: tgi_request_generated_tokens is a Histogram, so _sum is the
    // monotonic total; batch_current_size and queue_size are gauges. Never run
    // here.
    verified: "names"
  },  sglang: {
    label: "SGLang", port: 30000, probe: "/metrics", detect: "sglang:",
    filter: "^sglang:(generation_tokens_total|num_running_reqs|num_queue_reqs)",
    work: "sglang:generation_tokens_total",
    running: "sglang:num_running_reqs",
    waiting: "sglang:num_queue_reqs",
    // Names confirmed against upstream's production-metrics reference. Never
    // run here.
    verified: "names"
  },  openai: {
    label: "OpenAI-compatible", port: 1234, probe: "/v1/models", detect: null,
    filter: null,
    // LM Studio, KoboldCpp, oobabooga, TabbyAPI and friends expose no metrics
    // at all. Activity cannot be observed from outside without issuing
    // requests of our own, which would be dishonest instrumentation. These
    // report as reachable-but-silent rather than being drawn as idle.
    work: null,
    noActivity: true,
    verified: "n/a"
  }
}

// Derived from the runtime table, not written out again beside it.
//
// It used to be a second literal listing the same ports, kept in step with the
// per-runtime defaults by hand and by one test. Two sources for one fact is a
// drift waiting to happen; this has one.
var PORT_CANDIDATES = (function () {
  var seen = {}, out = []
  for (var key in RUNTIMES) {
    var port = RUNTIMES[key].port
    if (port && !seen[port]) { seen[port] = true; out.push(port) }
  }
  return out
})()

// Identify a runtime from a /metrics body by its series prefix. This is what
// lets the user enter an IP and nothing else: the prefix is unambiguous, and
// was confirmed against live vLLM and Ollama nodes.
function detectFromMetrics(body) {
  var text = String(body || "")
  for (var key in RUNTIMES) {
    var d = RUNTIMES[key].detect
    if (!d) continue
    // Anchored per line, so a prefix appearing inside a HELP string does not
    // decide the runtime.
    var re = new RegExp("^" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m")
    if (re.test(text)) return key
  }
  return null
}

// Aphrodite is a vLLM fork and emits the same `vllm:` series, so it is
// identified as vllm and needs no adapter of its own.

function runtimeOf(name) {
  return RUNTIMES[String(name || "").toLowerCase()] || null
}

// ── Prometheus ────────────────────────────────────────────────────────

// The model a metrics-bearing runtime is serving, read from labels already
// present on the series being fetched. Free: no extra request, no extra
// endpoint.
//
// The string is chosen by whoever runs the server, so it is treated like any
// other remote value: tail first, then stripped and clamped, before it can
// reach a label in the shared bar.
function modelFromMetrics(body) {
  var match = String(body || "").match(/model_name="([^"]*)"/)
  if (!match) return ""
  // Tail FIRST, then clamp. Clamping first let the vendor segment eat the
  // budget and cut the part this is supposed to keep:
  // "meta-llama/Meta-Llama-3.1-70B-Instruct" became "Meta-Llama-3.1-70B-I...",
  // and a 40-character vendor degenerated to an ellipsis alone.
  return stripLabel(shortModelName(match[1]))
}

function shortModelName(name) {
  var text = String(name || "")
  var slash = text.lastIndexOf("/")
  return slash === -1 ? text : text.slice(slash + 1)
}

// Sums every series sharing a metric name. vLLM emits one series per engine
// and per model, so a multi-model node would otherwise report only whichever
// line happened to be last.
// The model a metrics-bearing runtime is serving, read from the labels already
// present on the series we fetch. Free: no extra request, no extra endpoint.
//
// This string is chosen by whoever runs the server, so it is treated like any
// other remote value -- stripped and clamped before it can reach a label in the
// shared bar. A model id is also routinely a path ("Qwen/Qwen3.6-35B-A3B-FP8")
// and the leading vendor segment is the least informative part when space is
// short, so the tail is what survives.
function sumMetric(text, metric) {
  var lines = String(text || "").split("\n")
  var total = null
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.charAt(0) === "#") continue
    if (line.indexOf(metric) !== 0) continue
    // Either "name value" or "name{labels} value".
    var rest = line.slice(metric.length)
    if (rest.charAt(0) === "{") {
      var close = rest.indexOf("}")
      if (close === -1) continue
      rest = rest.slice(close + 1)
    } else if (rest.charAt(0) !== " ") {
      // A longer metric name that merely starts with this one.
      continue
    }
    var value = parseFloat(rest.trim().split(/\s+/)[0])
    if (isFinite(value)) total = (total === null ? 0 : total) + value
  }
  return total
}

// ── Sampling ──────────────────────────────────────────────────────────

// The MEAN of a series, for gauges rather than counters.
//
// sumMetric exists because vLLM emits one series per engine and per model, and
// summing is right for counts: two engines each running one request really are
// two requests. It is wrong for a FRACTION. Two engines each 50% full summed to
// 1, which the panel rendered as "100% cache" -- the headline "is it
// struggling" number, maximally wrong on exactly the multi-engine node
// sumMetric was written for.
function avgMetric(text, metric) {
  var values = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.charAt(0) === "#") continue
    if (line.indexOf(metric) !== 0) continue
    var rest = line.slice(metric.length)
    if (rest.charAt(0) !== "{" && rest.charAt(0) !== " ") continue
    // The FIRST field after the labels, not the last. The Prometheus text
    // format allows an optional timestamp after the value, and reading the last
    // field turned "0.5 1700000000000" into 1.7e12 -- rendered as
    // "170000000000000% cache". sumMetric, this function's near-twin, always
    // read the first; the two had drifted in the one line where they differ.
    var value = parseFloat(rest.replace(/^\{[^}]*\}/, "").trim().split(/\s+/)[0])
    if (isFinite(value)) values.push(value)
  }
  if (values.length === 0) return null
  var total = 0
  for (var v = 0; v < values.length; v++) total += values[v]
  return total / values.length
}

// One reading from one node. `work` is a monotonic counter where the runtime
// has one, or a token derived from Ollama's keep-alive expiry where it does
// not. `null` means "this runtime cannot tell us", which is different from 0.
function readSample(runtimeName, body) {
  var rt = runtimeOf(runtimeName)
  if (!rt) return null

  if (runtimeName === "ollama") {
    var models = []
    try {
      var parsed = JSON.parse(String(body || "{}"))
      var list = parsed.models || []
      for (var i = 0; i < list.length; i++) {
        models.push({ name: String(list[i].name || ""), expires: String(list[i].expires_at || "") })
      }
    } catch (e) {
      return null
    }
    models.sort(function (a, b) { return a.name < b.name ? -1 : 1 })
    var token = ""
    for (var m = 0; m < models.length; m++) token += models[m].name + "@" + models[m].expires + ";"
    return { work: null, token: token, running: null, waiting: null,
             // Tail FIRST, then clamp -- the same ordering the metrics path
             // uses. Clamping first let a long prefix eat the budget, and
             // "hf.co/unsloth/Qwen3-Coder-30B-..." is an ordinary Ollama name.
             cache: null, model: models.length ? stripLabel(shortModelName(models[0].name)) : "",
             loaded: models.length }
  }

  // A runtime with no work counter -- `openai` has none -- must not reach
  // sumMetric, which coerces a null metric name to the string "null" and then
  // dereferences the null itself. That threw inside _finish BEFORE _pending
  // was decremented, so `probing` stayed true and every later refresh returned
  // early: the widget froze on stale data, permanently, from one response body
  // containing a line that begins with "null".
  if (!rt.work) return null
  var work = sumMetric(body, rt.work)
  if (work === null) return null
  return {
    work: work,
    token: null,
    running: sumMetric(body, rt.running),
    waiting: sumMetric(body, rt.waiting),
    // A fraction on the wire; a percentage is what a person reads.
    // AVERAGED, not summed: this is a fraction per engine, not a count.
    cache: rt.cache ? avgMetric(body, rt.cache) : null,
    model: modelFromMetrics(body),
    loaded: null
  }
}

// Did this node do work between two samples?
//
// Returns { active, amount } where amount is tokens generated when the
// runtime counts them, and null when it can only say yes/no. A counter that
// goes BACKWARDS means the server restarted and reset it; that is not
// negative work, and reporting it as activity would light the widget on every
// restart.
function activityBetween(prev, curr) {
  if (!prev || !curr) return { active: false, amount: null }

  if (curr.work !== null && prev.work !== null) {
    var delta = curr.work - prev.work
    if (delta < 0) return { active: false, amount: null, reset: true }
    return { active: delta > 0, amount: delta }
  }

  if (curr.token !== null && prev.token !== null) {
    return { active: curr.token !== prev.token, amount: null }
  }

  return { active: false, amount: null }
}

// ── Fleet roll-up ─────────────────────────────────────────────────────

// The bar light is driven by this. `unknown` counts nodes that are up but
// cannot report activity, so the UI can say so instead of implying idle --
// a node whose runtime has no counter must never be drawn as "quiet".
function fleetState(nodes) {
  var up = 0, down = 0, active = 0, unknown = 0, tokens = 0, running = 0, waiting = 0
  var anyTokens = false, anyRunning = false

  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i]
    if (!n.reachable) { down++; continue }
    up++
    if (n.activity && n.activity.active) active++
    if (n.canReportActivity === false) unknown++
    if (n.activity && typeof n.activity.amount === "number") { tokens += n.activity.amount; anyTokens = true }
    if (typeof n.running === "number") { running += n.running; anyRunning = true }
    if (typeof n.waiting === "number") { waiting += n.waiting }
  }

  return {
    up: up,
    down: down,
    total: (nodes || []).length,
    active: active,
    unknown: unknown,
    busy: active > 0,
    tokens: anyTokens ? tokens : null,
    running: anyRunning ? running : null,
    waiting: anyRunning ? waiting : null
  }
}



var MAX_LABEL = 32

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
    var label = stripLabel(entry.slice(eq + 1))
    if (host !== "") out.push({ host: host, label: label })
  }
  return out
}

var MAX_MESSAGE = 160
function clampField(value) {
  var text = stripControl(String(value || "")).trim()
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 1) + "\u2026" : text
}

// Shared by clampField and stripLabel so there is one definition of "what may
// not appear in anything we render".
function stripControl(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\u0080-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/g, "")
}

// A nickname is typed by the user, not served by a node, but it is still
// rendered -- so it is stripped of anything that could break out of its row
// and clamped. Same reasoning as any other string this plugin displays.
// Strip and clamp a longer field than a nickname -- an error message naming
// several rejected addresses, for instance.
//
// This existed only as a CALL until now: Service.qml invoked Model.clampField
// and Model.js never defined it, carried over from a sibling plugin from
// memory. The binding that used it threw, QML left the property empty, and the
// bad-address message it was written to produce never appeared -- the exact
// silent-drop the feature was meant to end.
function stripLabel(value) {
  var text = stripControl(value).trim()
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + "\u2026" : text
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
// How long a nickname may be before it is cut. It is rendered in the bar's
// popup, and the bar belongs to the whole desktop -- a pasted essay should
// shorten, not reflow the panel.
function isSafeHost(host) {
  return /^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$/.test(String(host || ""))
}

// What a row is allowed to claim about a node, in order of honesty.
//
// Pure: node in, string out. It lived in Panel.qml, where the row and the
// column measurement each needed it and only a source extractor could test it.
function stateLabel(node) {
  if (!node) return ""
  if (!node.reachable) return "unreachable"
  if (node.canReportActivity === false) return "no activity signal"
  if (node.firstReading) return "measuring"
  if (node.activity && node.activity.active) {
    // Rounded for display only. TGI's work counter is a histogram _sum and is
    // genuinely a float, so a delta arrives as 3.000000000000001 -- which
    // rendered literally, and at 31 characters was wider than the column had
    // been sized for. The unrounded value stays in diagnostics.
    return typeof node.activity.amount === "number" && node.activity.amount >= 1
      ? "working  " + Math.round(node.activity.amount) + " tok"
      : "working"
  }
  return "idle"
}
