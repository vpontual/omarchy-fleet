// Everything the widget renders passes through Text first.
//
// Model names come from a server, nicknames from the user, and both end up in
// a label in the shared desktop bar -- so both are stripped of anything that
// could break out of a row, and clamped to a length that cannot reflow the
// panel.

const { test } = require("node:test")
const assert = require("node:assert")
const { Text, Metrics } = require("./harness.js")

test("a nickname is stripped and clamped before it is rendered", () => {
  // Typed by the user rather than served by a node, but still rendered in the
  // bar popup -- so it cannot carry control characters, cannot break out of
  // its row, and cannot be arbitrarily long.
  assert.equal(Text.stripLabel("a\u0007b"), "ab")
  assert.equal(Text.stripLabel("a\u202eb"), "ab")
  assert.equal(Text.stripLabel("a\u200bb"), "ab")
  assert.equal(Text.stripLabel("a\u2028b"), "ab")
  assert.equal(Text.stripLabel("  spaced  "), "spaced")
  const long = Text.stripLabel("x".repeat(200))
  assert.equal(long.length, Text.MAX_LABEL)
  assert.ok(long.endsWith("\u2026"), "a clamped nickname must show it was cut")
  // And it must not eat ordinary text.
  assert.equal(Text.stripLabel("DGX Spark (128GB)"), "DGX Spark (128GB)")
})

test("a model name from a server is stripped before it is rendered", () => {
  // Whatever the operator named the model, rendered in the shared bar.
  const body = (name) => `vllm:num_requests_running{model_name="${name}"} 0.0`
  assert.equal(Metrics.modelFromMetrics(body("qwen3:4b")), "qwen3:4b")
  assert.equal(Metrics.modelFromMetrics(body("a\u0007b")), "ab")
  assert.equal(Metrics.modelFromMetrics(body("a\u202eb")), "ab")
  assert.equal(Metrics.modelFromMetrics(body("a\u200bb")), "ab")
  assert.equal(Metrics.modelFromMetrics(body("a\u2028b")), "ab")
  const long = Metrics.modelFromMetrics(body("x".repeat(200)))
  assert.ok(long.length <= Text.MAX_LABEL, `unclamped model name: ${long.length}`)
  assert.equal(Metrics.modelFromMetrics("no labels here"), "")
})

test("a model id that is a path shows its tail, not its vendor", () => {
  assert.equal(Text.shortModelName("Qwen/Qwen3.6-35B-A3B-FP8"), "Qwen3.6-35B-A3B-FP8")
  assert.equal(Text.shortModelName("meta-llama/Llama-3-8B"), "Llama-3-8B")
  assert.equal(Text.shortModelName("qwen3:4b"), "qwen3:4b")
  assert.equal(Text.shortModelName(""), "")
})

test("a long vendor prefix does not eat the model name's budget", () => {
  // Ordering, not stripping: clamping BEFORE taking the tail let the vendor
  // segment consume the 32-character budget and cut the part the tail is
  // supposed to keep. "meta-llama/Meta-Llama-3.1-70B-Instruct" became
  // "Meta-Llama-3.1-70B-I..." and a 40-character vendor degenerated to an
  // ellipsis alone. Both orderings strip and both clamp, so only a fixture
  // whose vendor is long enough to matter can tell them apart.
  const body = (name) => `vllm:num_requests_running{model_name="${name}"} 0.0`
  assert.equal(Metrics.modelFromMetrics(body("meta-llama/Meta-Llama-3.1-70B-Instruct")),
    "Meta-Llama-3.1-70B-Instruct")
  assert.equal(Metrics.modelFromMetrics(body("Qwen/Qwen3.6-35B-A3B-FP8")), "Qwen3.6-35B-A3B-FP8")

  // A vendor longer than the whole budget must not leave an ellipsis alone.
  const out = Metrics.modelFromMetrics(body("a".repeat(40) + "/Llama-3-8B"))
  assert.equal(out, "Llama-3-8B")

  // And a tail that genuinely exceeds the budget still clamps.
  const long = Metrics.modelFromMetrics(body("vendor/" + "x".repeat(100)))
  assert.equal(long.length, Text.MAX_LABEL)
  assert.ok(long.endsWith("\u2026"))
})

test("the Ollama path takes the tail before clamping, like the metrics path", () => {
  // Fixed for vLLM and still live here: hf.co/... names are ordinary in
  // Ollama, and clamping first let the prefix eat the budget.
  const body = JSON.stringify({ models: [{
    name: "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    expires_at: "2026-01-01T00:00:00Z" }] })
  const model = Metrics.readSample("ollama", body).model
  assert.ok(!model.startsWith("hf.co"), `the vendor prefix survived: ${model}`)
  assert.ok(model.startsWith("Qwen3-Coder"), `the tail was cut: ${model}`)
  assert.ok(model.length <= Text.MAX_LABEL)

  // Both paths must agree on the rule.
  const viaMetrics = Metrics.modelFromMetrics(
    'vllm:x{model_name="hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M"} 0')
  assert.equal(model, viaMetrics, "the two model paths disagree on shortening")
})
