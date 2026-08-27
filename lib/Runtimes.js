.pragma library

// The inference runtimes this widget knows how to read, and how to tell them
// apart.
//
// Adding a runtime should be a DATA change, not a code change: an adapter says
// where to look, which series carries "work done so far", and which carry the
// numbers a row displays. Everything else in lib/ is written against this
// table rather than against any particular server.

// Hard ceiling on what any probe may hand back, applied in the shell BEFORE
// the bytes reach QML.
//
// Quickshell's StdioCollector has no size limit of its own, so whatever a
// probe emits is retained in full inside the process that draws the desktop.
// A real vLLM node's filtered reply is ~478 bytes; this exists for the server
// that answers with 11 MB of well-formed matching series, which is what one
// did -- every 3 seconds.
var MAX_PROBE_BYTES = 65536

//
// `probe` is the path to fetch. `filter` is an extended-regex handed to grep at
// the fetch boundary, so the shell never sees the other 99.7% of a 68 kB body.
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
    // No metrics endpoint, so no token counter. Ollama exposes each resident
    // model's keep-alive expiry instead, pushed forward when a request
    // COMPLETES -- so it can prove work happened and never that none is. Only
    // the CHANGE is meaningful: the value is on the node's clock, measured 15
    // minutes ahead of this laptop, so local time means nothing here.
    work: null,
    verified: "live"
  },  llamacpp: {
    label: "llama.cpp", port: 8080, probe: "/metrics", detect: "llamacpp:",
    filter: "^llamacpp:(tokens_predicted_total|requests_processing|requests_deferred)",
    work: "llamacpp:tokens_predicted_total",
    running: "llamacpp:requests_processing",
    waiting: "llamacpp:requests_deferred",
    // llama-server only serves /metrics when started with --metrics. Names
    // confirmed against upstream's own test suite
    // (tools/server/tests/unit/test_metrics.py). Never run here.
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
    //
    // Enforced by `work: null` with no token path, which makes readSample
    // return null. One mechanism, not a flag beside it that never fires.
    work: null,
    verified: "n/a"
  }
}

// Derived from the runtime table rather than written out beside it: two
// sources for one fact is a drift waiting to happen.
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
// was confirmed against live vLLM and Ollama nodes. Aphrodite is a vLLM fork
// emitting the same `vllm:` series, so it lands on vllm and needs no adapter.
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

// Look up an adapter by name, or null. Every caller must handle null: the name
// can come from a cached entry written by an older version of this file.
function runtimeOf(name) {
  return RUNTIMES[String(name || "").toLowerCase()] || null
}
