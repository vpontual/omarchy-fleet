// The runtime adapter table: what each server type is detected by, and what
// each adapter promises the rest of the plugin it can read.
//
// Adding a runtime is meant to be a data change, so these are the tests that
// keep the data honest -- every adapter is exercised against a body in the
// shape that runtime really publishes.

const { test } = require("node:test")
const assert = require("node:assert")
const { Runtimes, Metrics } = require("./harness.js")
const { BODIES } = require("./fixtures.js")

test("every runtime declares a probe path and a default port", () => {
  for (const [name, rt] of Object.entries(Runtimes.RUNTIMES)) {
    assert.ok(rt.probe, `${name} probe`)
    assert.ok(Number.isInteger(rt.port), `${name} port`)
    assert.ok(rt.label, `${name} label`)
  }
})

test("every default port is in the discovery sweep", () => {
  // Otherwise a user entering a bare host could never have that runtime found.
  for (const [name, rt] of Object.entries(Runtimes.RUNTIMES)) {
    assert.ok(Runtimes.PORT_CANDIDATES.includes(rt.port), `${name} port ${rt.port} not swept`)
  }
})

test("detects each metrics-bearing runtime by series prefix", () => {
  assert.equal(Runtimes.detectFromMetrics('vllm:num_requests_running{a="1"} 0.0'), "vllm")
  assert.equal(Runtimes.detectFromMetrics("sglang:num_running_reqs 2.0"), "sglang")
  assert.equal(Runtimes.detectFromMetrics("llamacpp:requests_processing 1"), "llamacpp")
  assert.equal(Runtimes.detectFromMetrics("tgi_queue_size 0"), "tgi")
})

test("a prefix inside a HELP line does not decide the runtime", () => {
  // Prometheus HELP text is prose and can mention anything.
  assert.equal(Runtimes.detectFromMetrics("# HELP other_metric compare with vllm: numbers"), null)
  assert.equal(Runtimes.detectFromMetrics(""), null)
  assert.equal(Runtimes.detectFromMetrics(null), null)
})

test("a 404 error page is never mistaken for metrics", () => {
  // Ollama serves "404 page not found" at /metrics with a non-empty body.
  // Accepting any non-empty body as metrics made discovery stop there and
  // never reach /api/ps, so a real Ollama node reported as unreachable.
  // The probe now uses curl -f AND requires a known series prefix.
  assert.equal(Runtimes.detectFromMetrics("404 page not found"), null)
  assert.equal(Metrics.readSample("vllm", "404 page not found"), null)
})

test("a runtime with no activity signal is flagged, not silently zeroed", () => {
  assert.equal(Runtimes.RUNTIMES.openai.work, null)
  assert.equal(Runtimes.RUNTIMES.ollama.work, null, "ollama counts nothing either")
  // The mechanism, executed rather than asserted as a flag. There WAS a
  // `noActivity: true` on the openai adapter and it never fired: readSample
  // returns null for that runtime first, and the caller keys off the null.
  // Replacing the flag's only use with a constant left the suite green, which
  // is the definition of a decorative one.
  assert.equal(Metrics.readSample("openai", JSON.stringify({ data: [{ id: "some-model" }] })), null,
    "an OpenAI-compatible body must not yield a sample")
  // ...and ollama, which also has no work counter, still does yield one.
  assert.ok(Metrics.readSample("ollama", JSON.stringify({ models: [] })),
    "ollama reports through its keep-alive token, not a counter")
})

test("the runtime table and the port sweep cannot drift apart", () => {
  // Two sources of one fact. PORT_CANDIDATES is a separate literal from the
  // per-runtime `port` fields, kept in step by hand.
  for (const key of Object.keys(Runtimes.RUNTIMES)) {
    const rt = Runtimes.RUNTIMES[key]
    if (!rt.port) continue
    assert.ok(Runtimes.PORT_CANDIDATES.indexOf(rt.port) !== -1,
      `${key} defaults to port ${rt.port}, which the sweep never tries`)
  }
})

test("every metrics runtime is detected from a body in its real shape", () => {
  for (const [runtime, body] of Object.entries(BODIES)) {
    assert.equal(Runtimes.detectFromMetrics(body), runtime,
      `${runtime} is not detected from its own exposition`)
  }
})

test("the verified level is one of the ones the README explains", () => {
  // The README's support table is generated from these by hand. A new value
  // here without a matching row there is how a support claim drifts.
  const allowed = ["live", "names", "n/a"]
  for (const [key, rt] of Object.entries(Runtimes.RUNTIMES)) {
    assert.ok(allowed.indexOf(rt.verified) !== -1,
      `${key} claims verification level ${JSON.stringify(rt.verified)}`)
  }
  // Only what has actually been run may claim "live".
  assert.equal(Runtimes.RUNTIMES.vllm.verified, "live")
  assert.equal(Runtimes.RUNTIMES.ollama.verified, "live")
  for (const k of ["llamacpp", "sglang", "tgi"]) {
    assert.equal(Runtimes.RUNTIMES[k].verified, "names",
      `${k} has never been run and must not claim otherwise`)
  }
})
