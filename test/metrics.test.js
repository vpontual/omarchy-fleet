// Prometheus parsing and the activity delta.
//
// Counters SUM across engines and models; fractions must be AVERAGED. Getting
// that backwards reported two engines at 50% as "100% cache", which is the
// headline "is it struggling" number, maximally wrong on exactly the
// multi-engine node the summing was written for.

const { test } = require("node:test")
const assert = require("node:assert")
const { Runtimes, Metrics, Fleet, readingOf } = require("./harness.js")
const { VLLM, OLLAMA_PS, OLLAMA_PS_LATER, BODIES } = require("./fixtures.js")

test("sumMetric reads a labelled series, summed across engines", () => {
  // 48456 on engine 0 plus 12000 on engine 1. Summing is correct for a
  // COUNTER: two engines' tokens really are the node's tokens.
  assert.equal(Metrics.sumMetric(VLLM, "vllm:generation_tokens_total"), 60456)
})

test("a per-engine FRACTION is averaged, not summed", () => {
  // The fixture is two engines at 40% and 60%. Summing gave 1.0, which the
  // panel rendered as "100% cache" -- the headline "is it struggling" number,
  // maximally wrong on exactly the multi-engine node sumMetric exists for.
  assert.equal(Metrics.avgMetric(VLLM, "vllm:kv_cache_usage_perc"), 0.5)
  assert.equal(Metrics.readSample("vllm", VLLM).cache, 0.5)

  // Four engines under real pressure must still land in range.
  const four = [0.5, 0.5, 0.9, 0.9]
    .map((v, i) => `vllm:kv_cache_usage_perc{engine="${i}",model_name="m"} ${v}`)
    .concat(['vllm:generation_tokens_total{engine="0",model_name="m"} 1.0']).join("\n")
  const cache = Metrics.readSample("vllm", four).cache
  assert.ok(cache > 0 && cache <= 1, `a fraction left its range: ${cache}`)
  assert.equal(Math.round(cache * 100), 70)

  assert.equal(Metrics.avgMetric(VLLM, "vllm:not_present"), null)
})

test("sumMetric SUMS every series sharing a name", () => {
  // vLLM emits one series per engine and per model. Taking the last line
  // would silently report a fraction of a multi-model node's work.
  const two = 'x:t{engine="0"} 100.0\nx:t{engine="1"} 25.0'
  assert.equal(Metrics.sumMetric(two, "x:t"), 125)
})

test("sumMetric does not match a longer metric that merely starts the same", () => {
  // tgi_request_generated_tokens_sum vs _count is exactly this hazard.
  const both = "m_sum 10.0\nm_count 3.0"
  assert.equal(Metrics.sumMetric(both, "m_sum"), 10)
  assert.equal(Metrics.sumMetric(both, "m"), null)
})

test("sumMetric ignores comments and returns null when absent", () => {
  assert.equal(Metrics.sumMetric("# TYPE x:t counter", "x:t"), null)
  assert.equal(Metrics.sumMetric("", "x:t"), null)
  assert.equal(Metrics.sumMetric(null, "x:t"), null)
})

test("counter delta is the activity signal", () => {
  const a = Metrics.readSample("vllm", VLLM)
  const b = Metrics.readSample("vllm", VLLM.replace("48456.0", "48458.0"))
  // The real measurement: one 2-token completion on the DGX.
  assert.deepEqual(Metrics.activityBetween(a, b), { active: true, amount: 2 })
})

test("no change means idle", () => {
  const a = Metrics.readSample("vllm", VLLM)
  assert.deepEqual(Metrics.activityBetween(a, a), { active: false, amount: 0 })
})

test("ollama activity comes from the keep-alive expiry CHANGING", () => {
  // Verified live: stable across a 6s idle gap, advanced on the next request.
  const a = Metrics.readSample("ollama", OLLAMA_PS)
  const b = Metrics.readSample("ollama", OLLAMA_PS_LATER)
  assert.equal(Metrics.activityBetween(a, a).active, false, "idle")
  assert.equal(Metrics.activityBetween(a, b).active, true, "used")
  // It cannot count tokens, and must not pretend to.
  assert.equal(Metrics.activityBetween(a, b).amount, null)
})

test("ollama expiry is never treated as an absolute time", () => {
  // The node's clock ran 15 minutes ahead of the laptop in testing, so any
  // comparison against local time would be nonsense. Only the token matters.
  const s = Metrics.readSample("ollama", OLLAMA_PS)
  assert.equal(s.work, null)
  assert.ok(typeof s.token === "string" && s.token.includes("qwen3-embedding"))
})

test("readSample rejects unparseable bodies rather than inventing zero", () => {
  assert.equal(Metrics.readSample("ollama", "not json"), null)
  assert.equal(Metrics.readSample("vllm", "nothing useful here"), null)
  assert.equal(Metrics.readSample("nonsense-runtime", VLLM), null)
})

test("no runtime can throw out of readSample, whatever a server returns", () => {
  // `openai` has no work counter, so rt.work was null and sumMetric
  // dereferenced it. That threw inside _finish BEFORE _pending was
  // decremented, leaving `probing` true so every later refresh returned early
  // -- the widget frozen on stale data, permanently, from one response body.
  const hostile = [
    '{"object":"list","data":[]}\nnull\n',
    "null",
    "null 1.0",
    "",
    "{",
    "vllm:generation_tokens_total{} not-a-number",
    "\n\n\n",
    "x".repeat(5000)
  ]
  for (const runtime of Object.keys(Runtimes.RUNTIMES)) {
    for (const body of hostile) {
      assert.doesNotThrow(() => Metrics.readSample(runtime, body),
        `${runtime} threw on ${JSON.stringify(body.slice(0, 30))}`)
    }
  }
  // The specific reachable case: an openai node on its second poll.
  assert.equal(Metrics.readSample("openai", '{"object":"list","data":[]}\nnull\n'), null)
})

test("avgMetric reads the value, not a trailing timestamp", () => {
  // The Prometheus text format allows an optional timestamp after the value.
  // Reading the LAST whitespace field turned "0.5 1700000000000" into 1.7e12,
  // rendered as "170000000000000% cache". sumMetric, this function's near-twin,
  // always read the first -- the two had drifted in the one line where they
  // differ.
  const stamped = 'vllm:kv_cache_usage_perc{model_name="m"} 0.5 1700000000000'
  assert.equal(Metrics.avgMetric(stamped, "vllm:kv_cache_usage_perc"), 0.5)
  assert.equal(Metrics.sumMetric(stamped, "vllm:kv_cache_usage_perc"), 0.5,
    "the two readers must agree on where the value is")

  // A gauge can never leave 0..1 and reach the panel as a percentage.
  const body = [0.4, 0.6].map((v, i) =>
    `vllm:kv_cache_usage_perc{engine="${i}"} ${v} 1700000000000`).join("\n")
    + '\nvllm:generation_tokens_total{engine="0"} 5.0'
  const cache = Metrics.readSample("vllm", body).cache
  assert.ok(cache >= 0 && cache <= 1, `a fraction left its range: ${cache}`)
  assert.equal(cache, 0.5)
})

test("every metrics runtime yields a usable sample", () => {
  const expected = {
    llamacpp: { work: 1250, running: 2, waiting: 1 },
    sglang:   { work: 4400, running: 3, waiting: 2 },
    tgi:      { work: 8123, running: 4, waiting: 7 }
  }
  for (const [runtime, body] of Object.entries(BODIES)) {
    const s = Metrics.readSample(runtime, body)
    assert.ok(s, `${runtime} produced no sample`)
    assert.equal(s.work, expected[runtime].work, `${runtime} work`)
    assert.equal(s.running, expected[runtime].running, `${runtime} running`)
    assert.equal(s.waiting, expected[runtime].waiting, `${runtime} waiting`)
  }
})

test("a fractional token delta is rounded before it is shown", () => {
  // TGI's work counter is a histogram _sum and is genuinely a float, so a
  // delta arrives as 3.000000000000001 -- rendered literally, and at 31
  // characters wider than the column had been sized for.
  const messy = Metrics.activityBetween({ work: 1.0 }, { work: 4.000000000000001 })
  assert.equal(Fleet.stateLabel({ read: true, reachable: true, activity: messy }), "working  3 tok")
  // Under a whole token there is no count worth printing.
  assert.equal(Fleet.stateLabel({ read: true, reachable: true, activity: { active: true, amount: 0.4 } }),
    "working")
  // Whole numbers are unchanged.
  assert.equal(Fleet.stateLabel({ read: true, reachable: true, activity: { active: true, amount: 42 } }),
    "working  42 tok")
  // And the state column is still sized for what it can hold.
  assert.ok("working  9999 tok".length >= "working  3 tok".length)
})

test("a partial exporter keeps the numbers it did publish", () => {
  // readSample used to return null the moment the work counter was missing,
  // throwing away running/waiting/cache/model with it -- so a node at 8
  // requests and 97% cache was drawn as quiet AND lost its own numbers.
  const partial = [
    'vllm:num_requests_running{engine="0"} 8',
    'vllm:num_requests_waiting{engine="0"} 3',
    'vllm:kv_cache_usage_perc{engine="0"} 0.97'
  ].join("\n")
  const s = Metrics.readSample("vllm", partial)
  assert.ok(s, "a partial body produced nothing at all")
  assert.equal(s.work, null, "there is no work counter to report")
  assert.equal(s.running, 8)
  assert.equal(s.waiting, 3)
  assert.equal(s.cache, 0.97)
  // With nothing readable at all it is still null.
  assert.equal(Metrics.readSample("vllm", "unrelated: 1"), null)
  // And a node that cannot report activity does not claim to be idle.
  assert.equal(Fleet.stateLabel({ read: true, reachable: true, canReportActivity: false }),
    "no activity signal")
})

test("Ollama's keep-alive signal is not mistaken for no signal at all", () => {
  // Ollama has no token counter, so its sample legitimately carries
  // work === null and signals through `token` instead. A guard that tested
  // only `work` marked every healthy Ollama node as unable to report activity
  // — found by looking at a real one, not by the suite.
  const body = JSON.stringify({ models: [
    { name: "qwen3:4b", expires_at: "2026-01-01T00:05:00Z" }] })
  const s = Metrics.readSample("ollama", body)
  assert.equal(s.work, null, "ollama has no work counter")
  assert.ok(s.token, "ollama must still carry its keep-alive token")

  // And the assembler must not read that as "no signal at all".
  const first = readingOf("PORT 11434\nRT ollama\n" + body, {})
  assert.notEqual(first.node.canReportActivity, false,
    "a healthy ollama node was marked unable to report activity")

  // Two readings with a moved expiry are activity.
  const later = Metrics.readSample("ollama", JSON.stringify({ models: [
    { name: "qwen3:4b", expires_at: "2026-01-01T00:09:00Z" }] }))
  assert.equal(Metrics.activityBetween(s, later).active, true,
    "a moved keep-alive expiry is the ollama activity signal")
  assert.equal(Metrics.activityBetween(s, s).active, false)
})

test("Ollama with nothing loaded is idle, not unreadable", () => {
  // `{"models":[]}` produced an empty token, which is falsy, so a healthy
  // Ollama with no resident model was reported as having no activity signal --
  // an absence of evidence, where the evidence was actually conclusive. It
  // cannot be generating if nothing is loaded.
  const empty = Metrics.readSample("ollama", JSON.stringify({ models: [] }))
  assert.ok(empty, "an empty model list yielded no sample at all")
  assert.ok(empty.token, "an unloaded Ollama cannot report anything")
  assert.equal(empty.model, "")

  // Two such polls compare equal, which is "idle" -- a real answer.
  const moved = Metrics.activityBetween(empty, Metrics.readSample("ollama", JSON.stringify({ models: [] })))
  assert.ok(moved, "two comparable readings were reported as incomparable")
  assert.equal(moved.active, false)

  // The sentinel must not collide with a real token, which always ends in ";".
  assert.ok(!/;/.test(empty.token))
  const loaded = Metrics.readSample("ollama", OLLAMA_PS)
  assert.notEqual(loaded.token, empty.token, "a loaded model looks unloaded")

  // LOADING a model is not generating with it. This line used to assert the
  // opposite -- it is the same defect as reading an eviction as work, and the
  // test enshrined it.
  assert.equal(Metrics.activityBetween(empty, loaded).active, false,
    "a model appearing was reported as work")
})

test("Ollama's keep-alive can prove work happened, never that none is", () => {
  // Measured against a live server across a 25-second generation: `expires_at`
  // did not move once during it -- eight consecutive identical polls -- and
  // advanced only after the generation FINISHED. Ollama sets it when the last
  // reference is released. So "the expiry did not move" is precisely what a
  // generating server looks like, and it was drawn bold green "idle".
  const at = (name, expires) => ({ name: name, expires_at: expires, size_vram: 1 })
  const ps = (models) => JSON.stringify({ models: models })
  const sample = (models) => Metrics.readSample("ollama", ps(models))
  const row = (before, now) =>
    Fleet.stateLabel(readingOf("PORT 11434\nRT ollama\n" + ps(now), { sample: sample(before) }).node)

  const T0 = "2026-08-27T13:54:07.815474896Z"
  const T1 = "2026-08-27T13:54:41.095477389Z"

  assert.equal(row([at("q", T0)], [at("q", T0)]), "no activity signal",
    "a generating Ollama node was drawn idle")
  assert.equal(row([at("q", T0)], [at("q", T1)]), "working",
    "a completed generation was not reported")

  // With keep_alive:-1 the expiry is a constant -- measured as a year 2318
  // timestamp -- so an idle claim would have stood forever.
  const FOREVER = "2318-12-07T13:27:49.871206114Z"
  assert.equal(row([at("q", FOREVER)], [at("q", FOREVER)]), "no activity signal")

  // But an EMPTY model list is conclusive: nothing loaded cannot be running.
  // That is a real "idle", and it must survive the rule above.
  assert.equal(row([], []), "idle", "a server with nothing resident lost a true answer")
  assert.equal(row([at("q", T0)], []), "idle", "an evicted model is not still generating")

  // A model appearing is not work either -- loaded is not used.
  assert.equal(row([at("q", T0)], [at("q", T0), at("z", T1)]), "no activity signal",
    "loading a second model was reported as generation")

  // Ordering is by PARSED time, not by string. Ollama's fractional-second
  // field varies in length, and a shorter fraction that is a numeric prefix of
  // a longer one compares backwards: the terminating "Z" sorts above every
  // digit, so ".79Z" reads as LATER than ".7994Z" while being 9ms earlier.
  const earlier = "2026-08-27T13:54:07.79Z", later = "2026-08-27T13:54:07.7994Z"
  assert.ok(!(earlier < later), "the premise of this check no longer holds")
  assert.ok(Date.parse(earlier) < Date.parse(later), "these are not 9ms apart")
  assert.equal(row([at("q", earlier)], [at("q", later)]), "working",
    "an expiry that advanced was missed because the string sorted backwards")
  assert.equal(row([at("q", later)], [at("q", earlier)]), "no activity signal",
    "an expiry going backwards was read as work")

  // An unorderable pair claims nothing, which can only withhold a "working".
  assert.equal(row([at("q", "not-a-time")], [at("q", "also-not")]), "no activity signal")
})

test("a work counter still supports an idle claim", () => {
  // The one-directional rule above must not leak onto the runtimes that DO
  // count work: a vLLM counter that did not move is a measurement of quiet.
  const before = Metrics.readSample("vllm", VLLM)
  const after = Metrics.readSample("vllm", VLLM)
  assert.equal(Metrics.activityBetween(before, after).active, false)
  const node = readingOf("PORT 8000\nRT vllm\n" + VLLM, { sample: before }).node
  assert.equal(Fleet.stateLabel(node), "idle",
    "a counter that did not move stopped being evidence of quiet")
  assert.notEqual(node.canReportActivity, false)
})
