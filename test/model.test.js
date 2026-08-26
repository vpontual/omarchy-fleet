// Model.js is loaded by QML as a plain script and has no exports, so the tests
// evaluate it and lift the functions out rather than compromising the plugin
// file for the test runner's benefit.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
const Model = new Function(
  source +
    "; return { RUNTIMES, PORT_CANDIDATES, runtimeOf, detectFromMetrics, sumMetric," +
    " readSample, activityBetween, fleetState, isSafeHost, MAX_PROBE_BYTES, parseServers, stripLabel, MAX_LABEL, splitHostPort, PROBE_TIMEOUT_SEC, modelFromMetrics, shortModelName, avgMetric, stateLabel, clampField, stripControl, MAX_MESSAGE }"
)()

// Captured verbatim from a live vLLM node (DGX Spark), trimmed to the series
// the plugin actually filters for. Two engines' worth of series are present on
// purpose: vLLM emits one per engine/model and the sum is what matters.
const VLLM = [
  '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
  '# TYPE vllm:generation_tokens_total counter',
  'vllm:generation_tokens_total{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 48456.0',
  'vllm:generation_tokens_total{engine="1",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 12000.0',
  'vllm:kv_cache_usage_perc{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.4',
  'vllm:kv_cache_usage_perc{engine="1",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.6',
  'vllm:num_requests_running{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.0',
  'vllm:num_requests_waiting{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.0'
].join("\n")

const OLLAMA_PS = JSON.stringify({
  models: [{ name: "qwen3-embedding:0.6b", expires_at: "2026-08-25T23:04:54.790456934Z", size_vram: 2176054080 }]
})
const OLLAMA_PS_LATER = JSON.stringify({
  models: [{ name: "qwen3-embedding:0.6b", expires_at: "2026-08-25T23:05:33.189782316Z", size_vram: 2176054080 }]
})

// ── Runtime table ─────────────────────────────────────────────────────

test("every runtime declares a probe path and a default port", () => {
  for (const [name, rt] of Object.entries(Model.RUNTIMES)) {
    assert.ok(rt.probe, `${name} probe`)
    assert.ok(Number.isInteger(rt.port), `${name} port`)
    assert.ok(rt.label, `${name} label`)
  }
})

test("every default port is in the discovery sweep", () => {
  // Otherwise a user entering a bare host could never have that runtime found.
  for (const [name, rt] of Object.entries(Model.RUNTIMES)) {
    assert.ok(Model.PORT_CANDIDATES.includes(rt.port), `${name} port ${rt.port} not swept`)
  }
})

// ── Detection ─────────────────────────────────────────────────────────

test("detects each metrics-bearing runtime by series prefix", () => {
  assert.equal(Model.detectFromMetrics('vllm:num_requests_running{a="1"} 0.0'), "vllm")
  assert.equal(Model.detectFromMetrics("sglang:num_running_reqs 2.0"), "sglang")
  assert.equal(Model.detectFromMetrics("llamacpp:requests_processing 1"), "llamacpp")
  assert.equal(Model.detectFromMetrics("tgi_queue_size 0"), "tgi")
})

test("a prefix inside a HELP line does not decide the runtime", () => {
  // Prometheus HELP text is prose and can mention anything.
  assert.equal(Model.detectFromMetrics("# HELP other_metric compare with vllm: numbers"), null)
  assert.equal(Model.detectFromMetrics(""), null)
  assert.equal(Model.detectFromMetrics(null), null)
})

// ── Prometheus parsing ────────────────────────────────────────────────

test("sumMetric reads a labelled series, summed across engines", () => {
  // 48456 on engine 0 plus 12000 on engine 1. Summing is correct for a
  // COUNTER: two engines' tokens really are the node's tokens.
  assert.equal(Model.sumMetric(VLLM, "vllm:generation_tokens_total"), 60456)
})

test("a per-engine FRACTION is averaged, not summed", () => {
  // The fixture is two engines at 40% and 60%. Summing gave 1.0, which the
  // panel rendered as "100% cache" -- the headline "is it struggling" number,
  // maximally wrong on exactly the multi-engine node sumMetric exists for.
  assert.equal(Model.avgMetric(VLLM, "vllm:kv_cache_usage_perc"), 0.5)
  assert.equal(Model.readSample("vllm", VLLM).cache, 0.5)

  // Four engines under real pressure must still land in range.
  const four = [0.5, 0.5, 0.9, 0.9]
    .map((v, i) => `vllm:kv_cache_usage_perc{engine="${i}",model_name="m"} ${v}`)
    .concat(['vllm:generation_tokens_total{engine="0",model_name="m"} 1.0']).join("\n")
  const cache = Model.readSample("vllm", four).cache
  assert.ok(cache > 0 && cache <= 1, `a fraction left its range: ${cache}`)
  assert.equal(Math.round(cache * 100), 70)

  assert.equal(Model.avgMetric(VLLM, "vllm:not_present"), null)
})

test("sumMetric SUMS every series sharing a name", () => {
  // vLLM emits one series per engine and per model. Taking the last line
  // would silently report a fraction of a multi-model node's work.
  const two = 'x:t{engine="0"} 100.0\nx:t{engine="1"} 25.0'
  assert.equal(Model.sumMetric(two, "x:t"), 125)
})

test("sumMetric does not match a longer metric that merely starts the same", () => {
  // tgi_request_generated_tokens_sum vs _count is exactly this hazard.
  const both = "m_sum 10.0\nm_count 3.0"
  assert.equal(Model.sumMetric(both, "m_sum"), 10)
  assert.equal(Model.sumMetric(both, "m"), null)
})

test("sumMetric ignores comments and returns null when absent", () => {
  assert.equal(Model.sumMetric("# TYPE x:t counter", "x:t"), null)
  assert.equal(Model.sumMetric("", "x:t"), null)
  assert.equal(Model.sumMetric(null, "x:t"), null)
})

// ── Activity ──────────────────────────────────────────────────────────

test("counter delta is the activity signal", () => {
  const a = Model.readSample("vllm", VLLM)
  const b = Model.readSample("vllm", VLLM.replace("48456.0", "48458.0"))
  // The real measurement: one 2-token completion on the DGX.
  assert.deepEqual(Model.activityBetween(a, b), { active: true, amount: 2 })
})

test("no change means idle", () => {
  const a = Model.readSample("vllm", VLLM)
  assert.deepEqual(Model.activityBetween(a, a), { active: false, amount: 0 })
})

test("a counter going backwards is a restart, not negative work", () => {
  // Reporting it as activity would flash the light on every server restart.
  const a = Model.readSample("vllm", VLLM)
  const b = Model.readSample("vllm", VLLM.replace("48456.0", "12.0"))
  const r = Model.activityBetween(a, b)
  assert.equal(r.active, false)
  assert.equal(r.reset, true)
})

test("ollama activity comes from the keep-alive expiry CHANGING", () => {
  // Verified live: stable across a 6s idle gap, advanced on the next request.
  const a = Model.readSample("ollama", OLLAMA_PS)
  const b = Model.readSample("ollama", OLLAMA_PS_LATER)
  assert.equal(Model.activityBetween(a, a).active, false, "idle")
  assert.equal(Model.activityBetween(a, b).active, true, "used")
  // It cannot count tokens, and must not pretend to.
  assert.equal(Model.activityBetween(a, b).amount, null)
})

test("ollama expiry is never treated as an absolute time", () => {
  // The node's clock ran 15 minutes ahead of the laptop in testing, so any
  // comparison against local time would be nonsense. Only the token matters.
  const s = Model.readSample("ollama", OLLAMA_PS)
  assert.equal(s.work, null)
  assert.ok(typeof s.token === "string" && s.token.includes("qwen3-embedding"))
})

test("readSample rejects unparseable bodies rather than inventing zero", () => {
  assert.equal(Model.readSample("ollama", "not json"), null)
  assert.equal(Model.readSample("vllm", "nothing useful here"), null)
  assert.equal(Model.readSample("nonsense-runtime", VLLM), null)
})

// ── Fleet roll-up ─────────────────────────────────────────────────────

test("fleetState counts up, down, and busy", () => {
  const s = Model.fleetState([
    { reachable: true, activity: { active: true, amount: 12 }, running: 1, waiting: 0 },
    { reachable: true, activity: { active: false, amount: 0 }, running: 0, waiting: 0 },
    { reachable: false }
  ])
  assert.equal(s.up, 2)
  assert.equal(s.down, 1)
  assert.equal(s.active, 1)
  assert.equal(s.busy, true)
  assert.equal(s.tokens, 12)
  assert.equal(s.running, 1)
})

test("a node that cannot report activity is counted as unknown, not idle", () => {
  // LM Studio and friends expose no metrics. Drawing them dark would claim
  // they are quiet when we simply cannot see them.
  const s = Model.fleetState([
    { reachable: true, canReportActivity: false, activity: { active: false, amount: null } }
  ])
  assert.equal(s.unknown, 1)
  assert.equal(s.busy, false)
  assert.equal(s.tokens, null, "must not report 0 tokens for a node that cannot count")
})

test("fleetState handles an empty fleet", () => {
  const s = Model.fleetState([])
  assert.equal(s.total, 0)
  assert.equal(s.busy, false)
  assert.equal(s.tokens, null)
})

// ── Host safety ───────────────────────────────────────────────────────

test("isSafeHost accepts hosts and host:port, rejects anything shell-relevant", () => {
  assert.ok(Model.isSafeHost("192.0.2.246"))
  assert.ok(Model.isSafeHost("192.0.2.246:8000"))
  assert.ok(Model.isSafeHost("gpu-box.local"))
  for (const bad of ["a;id", "a b", "a$(id)", "a`id`", "a|b", "a&b", "-x", "", "a:99999999", "a/b", "'a'"]) {
    assert.ok(!Model.isSafeHost(bad), `must reject ${JSON.stringify(bad)}`)
  }
})

test("a 404 error page is never mistaken for metrics", () => {
  // Ollama serves "404 page not found" at /metrics with a non-empty body.
  // Accepting any non-empty body as metrics made discovery stop there and
  // never reach /api/ps, so a real Ollama node reported as unreachable.
  // The probe now uses curl -f AND requires a known series prefix.
  assert.equal(Model.detectFromMetrics("404 page not found"), null)
  assert.equal(Model.readSample("vllm", "404 page not found"), null)
})

test("a runtime with no activity signal is flagged, not silently zeroed", () => {
  assert.equal(Model.RUNTIMES.openai.noActivity, true)
  assert.equal(Model.RUNTIMES.openai.work, null)
  assert.equal(Model.RUNTIMES.ollama.work, null, "ollama counts nothing either")
})

// ── The discovery probe, executed against a realistic body ───────────
// This plugin's whole purpose is reporting activity, and it silently could
// not: a real vLLM /metrics is ~68 kB and publishes num_requests_running at
// byte 6343 and generation_tokens_total at 13535, while discovery bounded the
// RAW body at `head -c 4000`. Detection still passed — the `vllm:` prefix
// appears early — so every node reported reachable while readSample returned
// null. And because the sample was null the discovered port was never cached,
// so the next poll re-ran discovery and truncated again. Permanently
// reachable, permanently idle, no error logged anywhere.

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "Service.qml"), "utf8")

// Probe.js is plain JS with no QML types, so it loads directly -- no source
// extractor, no brace matching, no chance of an assertion matching a comment.
const Probe = new Function(
  fs.readFileSync(path.join(__dirname, "..", "Probe.js"), "utf8") +
  "; return { script, parse }"
)()

function renderProbe(host, known) {
  // The REAL function, imported rather than scraped out of QML.
  return Probe.script(Model, host, known)
}


// A body shaped like the real thing: the series the plugin needs sit far past
// any fixed byte bound, behind a wall of histogram buckets.
function bigMetricsBody() {
  const filler = []
  for (let i = 0; i < 400; i++) {
    filler.push(`# HELP vllm:inter_token_latency_seconds_bucket latency`)
    filler.push(`vllm:inter_token_latency_seconds_bucket{le="${i / 100}",model_name="m"} ${i}.0`)
  }
  return [
    "# HELP vllm:cache_config_info cache",
    'vllm:cache_config_info{block_size="16"} 1.0',
    ...filler,
    'vllm:num_requests_running{engine="0",model_name="m"} 3.0',
    'vllm:num_requests_waiting{engine="0",model_name="m"} 1.0',
    'vllm:generation_tokens_total{engine="0",model_name="m"} 987654.0'
  ].join("\n")
}

test("discovery keeps the activity series no matter where they sit in the body", () => {
  const body = bigMetricsBody()
  assert.ok(body.length > 20000, "fixture must be larger than any fixed byte bound")
  assert.ok(body.indexOf("vllm:generation_tokens_total") > 4000,
    "the series must sit past the old 4000-byte bound, or this test proves nothing")

  // Run the REAL rendered pipeline: whatever curl would have produced is piped
  // through exactly the filter and bound the plugin builds.
  const cp = require("node:child_process")
  const script = renderProbe("10.0.0.1", null)
  const m = script.match(/\| (grep -E '[^']*') \| (head -c \d+)/)
  assert.ok(m, `discovery does not filter before bounding: ${script.split("\n")[1]}`)

  const out = cp.execFileSync("bash", ["-c", `${m[1]} | ${m[2]}`],
    { input: body, encoding: "utf8" })
  assert.ok(out.length > 0, "the filter discarded everything")
  assert.ok(out.length <= Model.MAX_PROBE_BYTES, "the output is not bounded")

  const sample = Model.readSample("vllm", out)
  assert.ok(sample, "discovery still yields no sample — activity can never be reported")
  assert.equal(sample.running, 3)
  assert.equal(sample.waiting, 1)
  assert.equal(sample.work, 987654)
})

test("discovery bounds a hostile endpoint even when every line matches", () => {
  // grep-before-head must not become unbounded: a server emitting matching
  // series forever has to be cut off.
  const cp = require("node:child_process")
  const script = renderProbe("10.0.0.1", null)
  const m = script.match(/\| (grep -E '[^']*') \| (head -c \d+)/)
  const flood = 'vllm:num_requests_running{model_name="m"} 1.0\n'.repeat(20000)
  // spawnSync, not execFileSync: `head` closing the pipe mid-write raises
  // EPIPE on the writer, which IS the bound working. Throwing there would
  // fail the test for the exact behaviour it is asserting.
  const r = cp.spawnSync("bash", ["-c", `${m[1]} | ${m[2]}`],
    { input: flood, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  const out = r.stdout || ""
  assert.ok(out.length > 0, "the flood produced nothing; fixture is wrong")
  assert.ok(out.length <= Model.MAX_PROBE_BYTES, `unbounded output: ${out.length} bytes`)
})

test("the probe pool is an Instantiator, and callers address it as one", () => {
  // A Repeater can only create Items; Process is a plain QtObject, so the pool
  // silently produced nothing and every host reported unreachable. The only
  // symptom was "Delegate must be of Item type" in the shell log.
  assert.ok(/Instantiator\s*\{/.test(SERVICE), "the probe pool is not an Instantiator")
  assert.ok(/probePool\.objectAt\(/.test(SERVICE),
    "the pool is addressed with itemAt(), which is Repeater-only and returns null here")
  assert.ok(!/probePool\.itemAt\(/.test(SERVICE), "itemAt() would return null for every host")
})

test("EVERY probe path is bounded, not just discovery", () => {
  // The steady-state path was unbounded. Discovery capped its body, but the
  // known-node probe -- which is what runs on every poll once a node has been
  // identified, so almost always -- piped curl straight into the collector.
  // Measured: 11.4 MB of well-formed matching series reached StdioCollector,
  // which has no size limit of its own, every 3 seconds.
  const known = renderProbe("10.0.0.1", { port: 8000, runtime: "vllm" })
  const discovery = renderProbe("10.0.0.1", null)
  for (const [name, script] of [["known-node", known], ["discovery", discovery]]) {
    // EVERY curl, not the first one that happens to be bounded. The previous
    // version regex-matched `head -c \d+` against the whole script: discovery
    // contains one bounded branch and two that were not, and the assertion was
    // satisfied by the bounded one while the other two printed an unfiltered
    // body straight to the collector.
    const curls = script.match(/curl [^\n]*/g) || []
    assert.ok(curls.length > 0, `${name} probe runs no curl at all`)
    for (const c of curls) {
      assert.ok(/head -c \d+/.test(c), `${name}: unbounded curl -> ${c.slice(0, 110)}`)
      const cap = parseInt(c.match(/head -c (\d+)/)[1])
      assert.equal(cap, Model.MAX_PROBE_BYTES, `${name}: magic number, not the shared ceiling`)
    }
    // And the whole script is bounded as one, so a future branch inherits it.
    assert.ok(new RegExp("\\}\\s*\\| head -c " + Model.MAX_PROBE_BYTES + "\\s*$").test(script.trim()),
      `${name}: the script's own stdout is not bounded as a whole`)
    // The bound must come AFTER the filter, or it truncates the body before
    // the series the parser needs are reached -- the original bug.
    if (/grep -E/.test(script)) {
      assert.ok(script.indexOf("grep -E") < script.lastIndexOf("head -c"),
        `${name} probe bounds before it filters`)
    }
  }
})

test("the known-node probe actually cuts off a flooding server", () => {
  const cp = require("node:child_process")
  const script = renderProbe("10.0.0.1", { port: 8000, runtime: "vllm" })
  const pipe = script.slice(script.indexOf("| grep -E"))
  const flood = 'vllm:num_requests_running{model_name="m"} 1.0\n'.repeat(300000)
  const r = cp.spawnSync("bash", ["-c", `cat ${pipe}`],
    { input: flood, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ""
  assert.ok(out.length > 0, "the fixture produced nothing")
  assert.ok(out.length <= Model.MAX_PROBE_BYTES,
    `${out.length} bytes reached the collector from a ${flood.length}-byte flood`)
})

test("the collector read is clamped as well as the probe", () => {
  // Defence in depth, and it needs a guard or it is a line nobody can tell is
  // missing. The probe script is the real bound; this means no parser can be
  // handed more than the ceiling even if a future probe path forgets one --
  // which is exactly what happened to the known-node probe.
  // The clamp moved into Probe.parse, where it can be tested by calling it.
  assert.equal(Probe.parse(Model, "PORT 8000\nRT vllm\n" + "x".repeat(200000),
    Model.MAX_PROBE_BYTES).body.length <= Model.MAX_PROBE_BYTES, true,
    "Probe.parse does not clamp what it is handed")
  assert.ok(/Probe\.parse\(Model, out, Model\.MAX_PROBE_BYTES\)/.test(SERVICE),
    "the collector read does not go through the clamped parser")
})

// ── Server nicknames ─────────────────────────────────────────────────

test("a bare server list still parses exactly as before", () => {
  // Backward compatibility is the point: existing configs are bare hosts,
  // comma OR whitespace separated, and must keep working untouched.
  assert.deepEqual(Model.parseServers("10.0.0.1, 10.0.0.2"),
    [{ host: "10.0.0.1", label: "" }, { host: "10.0.0.2", label: "" }])
  assert.deepEqual(Model.parseServers("10.0.0.1 10.0.0.2"),
    [{ host: "10.0.0.1", label: "" }, { host: "10.0.0.2", label: "" }])
  assert.deepEqual(Model.parseServers(""), [])
  assert.deepEqual(Model.parseServers(null), [])
})

test("host=Nickname names a server, and the nickname may contain spaces", () => {
  // The comma is the entry separator precisely so a nickname can have spaces;
  // splitting the whole string on whitespace would cut "DGX Spark" in two.
  assert.deepEqual(
    Model.parseServers("10.0.0.5=DGX Spark, gpu.local:8000 = My GPU Box"),
    [{ host: "10.0.0.5", label: "DGX Spark" },
     { host: "gpu.local:8000", label: "My GPU Box" }])
})

test("named and unnamed servers mix in one list", () => {
  assert.deepEqual(Model.parseServers("10.0.0.1=Nano, 10.0.0.2, 10.0.0.3=Orin"),
    [{ host: "10.0.0.1", label: "Nano" },
     { host: "10.0.0.2", label: "" },
     { host: "10.0.0.3", label: "Orin" }])
})

test("only the first = splits, so a nickname may contain one", () => {
  assert.deepEqual(Model.parseServers("10.0.0.1=a=b"),
    [{ host: "10.0.0.1", label: "a=b" }])
})

test("a nickname is stripped and clamped before it is rendered", () => {
  // Typed by the user rather than served by a node, but still rendered in the
  // bar popup -- so it cannot carry control characters, cannot break out of
  // its row, and cannot be arbitrarily long.
  assert.equal(Model.stripLabel("a\u0007b"), "ab")
  assert.equal(Model.stripLabel("a\u202eb"), "ab")
  assert.equal(Model.stripLabel("a\u200bb"), "ab")
  assert.equal(Model.stripLabel("a\u2028b"), "ab")
  assert.equal(Model.stripLabel("  spaced  "), "spaced")
  const long = Model.stripLabel("x".repeat(200))
  assert.equal(long.length, Model.MAX_LABEL)
  assert.ok(long.endsWith("\u2026"), "a clamped nickname must show it was cut")
  // And it must not eat ordinary text.
  assert.equal(Model.stripLabel("DGX Spark (128GB)"), "DGX Spark (128GB)")
})

test("a malformed host is still rejected even when it carries a nickname", () => {
  // The nickname must not become a way to smuggle something past isSafeHost.
  for (const bad of ["1.2.3.4; rm -rf /", "$(id)", "`id`", "10.0.0.1|x"]) {
    assert.equal(Model.isSafeHost(Model.parseServers(bad + "=Friendly")[0].host), false,
      `${bad} passed validation when named`)
  }
  assert.equal(Model.isSafeHost(Model.parseServers("10.0.0.1=Friendly")[0].host), true)
})

test("splitHostPort separates an explicit port, and leaves a bare host alone", () => {
  assert.deepEqual(Model.splitHostPort("gpu.local"), { host: "gpu.local", port: null })
  assert.deepEqual(Model.splitHostPort("gpu.local:8000"), { host: "gpu.local", port: 8000 })
  assert.deepEqual(Model.splitHostPort("10.0.0.5:11434"), { host: "10.0.0.5", port: 11434 })
  // Not a port -- leave the string intact rather than mangling it.
  assert.deepEqual(Model.splitHostPort("gpu.local:abc"), { host: "gpu.local:abc", port: null })
  assert.deepEqual(Model.splitHostPort(""), { host: "", port: null })
})

test("a configured port is probed, never appended to a sweep", () => {
  // The settings label, the manifest schema and the panel help text all
  // advertise `host:port`, and it never worked: discovery appended its own
  // port sweep to whatever it was given, so "gpu.local:8000" was probed as
  // "http://gpu.local:8000:8000/metrics" and the node reported unreachable
  // with nothing to say why.
  const withPort = renderProbe("gpu.local:8000", null)
  assert.ok(!/gpu\.local:8000:/.test(withPort), `double port in URL: ${withPort}`)
  assert.ok(/for p in 8000; do/.test(withPort),
    "an explicit port must be the only candidate, not one of a sweep")
  assert.ok(/http:\/\/gpu\.local:\$p/.test(withPort),
    "the URL must be built from the host WITHOUT its port")

  // A bare host still sweeps every candidate.
  const bare = renderProbe("gpu.local", null)
  assert.ok(new RegExp("for p in " + Model.PORT_CANDIDATES.join(" ")).test(bare),
    "a bare host must still sweep the candidate ports")

  // And the known-node path must not double it either.
  const known = renderProbe("gpu.local:8000", { port: 8000, runtime: "vllm" })
  assert.ok(!/gpu\.local:8000:/.test(known), `double port on the known path: ${known}`)
})

test("a probe is bounded as a whole, not just per request", () => {
  // `curl --max-time` bounds ONE request, and discovery can make fifteen:
  // five candidate ports times three endpoints. A host that drops packets
  // rather than refusing them had no overall bound, and the 15s watchdog only
  // resets the plugin's flags -- the processes carry on.
  assert.ok(Model.PROBE_TIMEOUT_SEC > 0 && Model.PROBE_TIMEOUT_SEC < 15,
    "the probe bound must fire before the 15s watchdog")
  const argv = SERVICE.match(/proc\.command = \[[\s\S]*?\]/)
  assert.ok(argv, "the probe command could not be found")
  const cmd = argv[0]
  const t = cmd.indexOf("timeout"), b = cmd.indexOf("bash")
  assert.ok(t !== -1 && b !== -1 && t < b,
    `timeout must wrap bash, not sit inside it: ${cmd}`)
  assert.ok(/-u", "BASH_ENV"/.test(cmd), "BASH_ENV is not cleared")
  assert.ok(/-u", "ENV"/.test(cmd), "ENV is not cleared")
})

test("the wrapper kills a hung probe and does not source BASH_ENV", () => {
  const cp = require("node:child_process"), os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-env-"))
  const marker = path.join(dir, "marker")
  fs.writeFileSync(path.join(dir, "evil.sh"), `printf INJECTED > ${marker}\n`)

  // Same argv shape the plugin builds, with a short bound so the test is fast.
  const run = (script, secs) => cp.spawnSync("/usr/bin/env",
    ["-u", "BASH_ENV", "-u", "ENV", "/usr/bin/timeout", "--signal=KILL", String(secs),
     "/usr/bin/bash", "-c", script],
    { env: { ...process.env, BASH_ENV: path.join(dir, "evil.sh") },
      encoding: "utf8", timeout: 20000 })

  const started = Date.now()
  const r = run("sleep 60", 2)
  assert.ok(Date.now() - started < 8000, "a hung probe was not bounded")
  assert.notEqual(r.status, 0, "a killed probe must not report success")
  assert.ok(!fs.existsSync(marker), "the probe sourced BASH_ENV")

  // Positive control: the fixture DOES fire without the guard, so a missing
  // marker cannot be explained by a broken fixture.
  cp.spawnSync("/usr/bin/bash", ["-c", "true"],
    { env: { ...process.env, BASH_ENV: path.join(dir, "evil.sh") }, encoding: "utf8" })
  assert.ok(fs.existsSync(marker), "fixture never fired; the test proves nothing")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the plugin has ONE name, everywhere a person sees it", () => {
  // The catalog listing reads manifest.name, the bar picker reads
  // displayName, and the panel draws its own title. They disagreed --
  // "LLM Fleet Activity" in the listing against "LLM Fleet" on screen --
  // which is the kind of thing nobody notices until it is published.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")

  const title = (panel.match(/title: "([^"]+)"/) || [])[1]
  const heading = readme.split("\n")[0].replace(/^#\s*/, "").trim()
  const names = [manifest.name, manifest.barWidget.displayName, title, heading]
  assert.equal(new Set(names).size, 1, `names disagree: ${JSON.stringify(names)}`)

  // The id is what shell.json keys on: changing it orphans every existing
  // configuration, so it is deliberately NOT tied to the display name.
  assert.equal(manifest.id, "veepee.fleet")
})

// ── The newest code, which mutation testing found unprotected ────────
// Four defences were present but unexercised: removing host validation
// entirely, dropping stripping from the model name, keeping the vendor prefix,
// and dropping the cache series from the probe filter all left the suite green.

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
  const self = { serversSetting: setting, Model }
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
  const self = { serversSetting: setting, Model }
  return new Function("self", `with (self) { return (function() ${body})() }`)(self).rejected
}

test("a host that is not shell-safe never reaches the probe", () => {
  // Host strings are interpolated into a bash command. isSafeHost is tested on
  // its own, but nothing tested that anything CALLS it -- replacing the check
  // with `if (false)` left every test passing.
  // The invariant is not "nothing comes back" -- a mangled entry can leave a
  // harmless-looking fragment behind ("1.2.3.4; touch /x" yields the token
  // "touch", which is a legal hostname that simply will not resolve). The
  // invariant is that NOTHING shell-relevant survives to reach the command.
  for (const bad of ["1.2.3.4; touch /tmp/pwned", "$(id)", "`id`", "a|b", "a&b",
                     "a>b", "a$b", "a'b", 'a"b', "a\\b", "a\nb"]) {
    for (const entry of runConfiguredServers(bad)) {
      assert.ok(Model.isSafeHost(entry.host),
        `unsafe host survived from ${JSON.stringify(bad)}: ${JSON.stringify(entry.host)}`)
      assert.ok(!/[;&|$`'"\\<>()\s]/.test(entry.host),
        `shell metacharacter reached a host: ${JSON.stringify(entry.host)}`)
    }
  }
  // The dangerous token itself must never appear as a host.
  const out = runConfiguredServers("1.2.3.4; touch /tmp/pwned")
  assert.ok(!out.some(e => e.host.includes(";")), "a host carrying ; was accepted")
  // A named unsafe host is refused too -- the nickname must not be a way past.
  assert.deepEqual(runConfiguredServers("1.2.3.4; id=Friendly"), [])
  // And legitimate forms still get through.
  assert.deepEqual(runConfiguredServers("gpu.local:8000=Big Box"),
    [{ host: "gpu.local:8000", label: "Big Box" }])
  assert.deepEqual(runConfiguredServers("10.0.0.5"), [{ host: "10.0.0.5", label: "" }])
})

test("a model name from a server is stripped before it is rendered", () => {
  // Whatever the operator named the model, rendered in the shared bar.
  const body = (name) => `vllm:num_requests_running{model_name="${name}"} 0.0`
  assert.equal(Model.modelFromMetrics(body("qwen3:4b")), "qwen3:4b")
  assert.equal(Model.modelFromMetrics(body("a\u0007b")), "ab")
  assert.equal(Model.modelFromMetrics(body("a\u202eb")), "ab")
  assert.equal(Model.modelFromMetrics(body("a\u200bb")), "ab")
  assert.equal(Model.modelFromMetrics(body("a\u2028b")), "ab")
  const long = Model.modelFromMetrics(body("x".repeat(200)))
  assert.ok(long.length <= Model.MAX_LABEL, `unclamped model name: ${long.length}`)
  assert.equal(Model.modelFromMetrics("no labels here"), "")
})

test("a model id that is a path shows its tail, not its vendor", () => {
  assert.equal(Model.shortModelName("Qwen/Qwen3.6-35B-A3B-FP8"), "Qwen3.6-35B-A3B-FP8")
  assert.equal(Model.shortModelName("meta-llama/Llama-3-8B"), "Llama-3-8B")
  assert.equal(Model.shortModelName("qwen3:4b"), "qwen3:4b")
  assert.equal(Model.shortModelName(""), "")
})

test("cache pressure survives the probe filter it has to pass through", () => {
  // The filter decides what the probe returns at all. A series missing from it
  // can never be read, however correct the parser is -- which is exactly how
  // the activity signal was silently dead before.
  const cp = require("node:child_process")
  const script = renderProbe("10.0.0.1", { port: 8000, runtime: "vllm" })
  const m = script.match(/\| (grep -E '[^']*')/)
  assert.ok(m, "the known-node probe does not filter")
  const body = [
    'vllm:num_requests_running{model_name="m"} 2.0',
    'vllm:num_requests_waiting{model_name="m"} 1.0',
    'vllm:kv_cache_usage_perc{model_name="m"} 0.42',
    'vllm:generation_tokens_total{model_name="m"} 500.0',
    'vllm:irrelevant_series{model_name="m"} 9.0'
  ].join("\n")
  const out = cp.spawnSync("bash", ["-c", m[1]], { input: body, encoding: "utf8" }).stdout
  const sample = Model.readSample("vllm", out)
  assert.ok(sample, "the filter discarded everything the parser needs")
  assert.equal(sample.cache, 0.42, "cache pressure did not survive the filter")
  assert.equal(sample.running, 2)
  assert.equal(sample.waiting, 1)
  assert.equal(sample.model, "m")
})

test("a flood on ANY discovery branch is cut off before the collector", () => {
  // The finding this replaces: /api/ps printed an entirely unfiltered body
  // straight to stdout, which StdioCollector retains in full inside the process
  // drawing the whole desktop bar. Driven through the real rendered script with
  // a stubbed curl, so every branch is exercised, not just the bounded one.
  const cp = require("node:child_process"), os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-flood-"))
  // A curl that answers every endpoint with 8 MiB of plausible body.
  fs.writeFileSync(path.join(dir, "curl"),
    '#!/bin/bash\n' +
    'for a in "$@"; do case "$a" in *"/api/ps") printf \'{"models": \'; ;; esac; done\n' +
    'head -c 8388608 /dev/zero | tr "\\0" "x"\n')
  fs.chmodSync(path.join(dir, "curl"), 0o755)
  try {
    const script = renderProbe("127.0.0.1:8000", null)
    const r = cp.spawnSync("/usr/bin/bash", ["-c", script], {
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000
    })
    const out = r.stdout || ""
    assert.ok(out.length > 0, "the stub produced nothing; the fixture is wrong")
    assert.ok(out.length <= Model.MAX_PROBE_BYTES,
      `${out.length} bytes reached the collector against a ceiling of ${Model.MAX_PROBE_BYTES}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a long vendor prefix does not eat the model name's budget", () => {
  // Ordering, not stripping: clamping BEFORE taking the tail let the vendor
  // segment consume the 32-character budget and cut the part the tail is
  // supposed to keep. "meta-llama/Meta-Llama-3.1-70B-Instruct" became
  // "Meta-Llama-3.1-70B-I..." and a 40-character vendor degenerated to an
  // ellipsis alone. Both orderings strip and both clamp, so only a fixture
  // whose vendor is long enough to matter can tell them apart.
  const body = (name) => `vllm:num_requests_running{model_name="${name}"} 0.0`
  assert.equal(Model.modelFromMetrics(body("meta-llama/Meta-Llama-3.1-70B-Instruct")),
    "Meta-Llama-3.1-70B-Instruct")
  assert.equal(Model.modelFromMetrics(body("Qwen/Qwen3.6-35B-A3B-FP8")), "Qwen3.6-35B-A3B-FP8")

  // A vendor longer than the whole budget must not leave an ellipsis alone.
  const out = Model.modelFromMetrics(body("a".repeat(40) + "/Llama-3-8B"))
  assert.equal(out, "Llama-3-8B")

  // And a tail that genuinely exceeds the budget still clamps.
  const long = Model.modelFromMetrics(body("vendor/" + "x".repeat(100)))
  assert.equal(long.length, Model.MAX_LABEL)
  assert.ok(long.endsWith("\u2026"))
})

// ── The non-blocking list from the adversarial review ────────────────

test("an unusable address is reported, not silently dropped", () => {
  // It used to vanish: the server was skipped and lastError was written as a
  // side effect of a BINDING being evaluated, surfacing only through the
  // diagnostics IPC verb. The panel showed a shorter fleet than configured
  // with nothing to explain it.
  assert.deepEqual(runConfiguredRejects("10.0.0.1, 10.0.0.2"), [])
  // "bad" on its own is a LEGAL hostname, so it is accepted, not rejected --
  // only the token carrying a metacharacter is refused.
  assert.deepEqual(runConfiguredRejects("10.0.0.1, host|x"), ["host|x"])
  assert.deepEqual(runConfiguredRejects("10.0.0.1, a|b, c&d"), ["a|b", "c&d"])
  // Good entries beside a bad one still come through.
  assert.deepEqual(runConfiguredServers("10.0.0.1, a|b"), [{ host: "10.0.0.1", label: "" }])

  // The panel must actually show it.
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.ok(/fleet\.configError/.test(panel), "the panel never reads configError")
  const detail = panel.slice(panel.indexOf("readonly property string detail:"))
  assert.ok(detail.indexOf("configError") < detail.indexOf("Add server addresses"),
    "a rejected address must be reported before the empty-config hint")
})

test("a late result from an abandoned cycle is discarded", () => {
  // The 15s watchdog resets probing/_pending but kills nothing. A straggler
  // used to decrement the NEW cycle's _pending, publishing a partial list and
  // then driving _pending negative, re-publishing on every further straggler.
  assert.ok(/property int _cycle/.test(SERVICE), "there is no cycle id")
  const finish = extractFunction("_finish")
  assert.ok(/cycle !== _cycle/.test(finish), "_finish does not fence late results")
  assert.ok(finish.indexOf("cycle !== _cycle") < finish.indexOf("_pending--"),
    "the fence must come before _pending is touched")
  // The watchdog must invalidate what it abandons.
  const wd = SERVICE.slice(SERVICE.indexOf("probe cycle did not finish"))
  assert.ok(/_cycle\+\+/.test(wd.slice(0, 300)),
    "the watchdog abandons a cycle without invalidating it")
})

test("an empty configuration does not churn every tick", () => {
  // `nodes = []` on every 3s tick re-evaluated fleet and all four TextMetrics
  // for a widget with nothing to show.
  const refresh = extractFunction("refresh")
  assert.ok(/if \(nodes\.length > 0\) nodes = \[\]/.test(refresh),
    "an empty config still reassigns nodes unconditionally")
})

test("runtime prefixes are validated, not sanitised by a no-op", () => {
  // The line used to carry `.replace(/:/g, ":")` -- a colon replaced by a
  // colon, a no-op wearing the costume of a sanitiser.
  // Check the CODE, not the comment that explains why the no-op is gone --
  // matching the whole file found the phrase inside that very comment.
  // Both assertions run against CODE, never comments: extractFunction returns
  // the comments too, and the comment here quotes the very regex being checked
  // for -- so asserting against the raw body passed with the validation gone.
  // Read Probe.js itself now that the builder lives there.
  const src = fs.readFileSync(path.join(__dirname, "..", "Probe.js"), "utf8")
  const code = src.split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
  assert.ok(!/replace\(\/:\/g/.test(code), "the no-op replace is back")
  assert.ok(/\^\[A-Za-z0-9_:\]\+\$/.test(code), "prefixes reach the shell unvalidated")
  assert.ok(/prefixes\[pi\]/.test(code), "nothing iterates the prefixes to validate them")
})

test("the diagnostics command in the source is the one that works", () => {
  // The comment named `omarchy-shell veepee.fleet diagnostics`, which is not a
  // real command. Only the qs ipc form is.
  assert.ok(!/omarchy-shell veepee\.fleet diagnostics/.test(SERVICE),
    "the source still names a command that does not exist")
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")
  const cmd = "qs -p /usr/share/omarchy/shell ipc call veepee.fleet diagnostics"
  assert.ok(SERVICE.includes(cmd) && readme.includes(cmd),
    "source and README disagree on the diagnostics command")
})

test("the settings label documents every form the parser accepts", () => {
  // The schema label is what a user reads in the settings UI, and it never
  // mentioned the nickname form the README documents.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  const label = manifest.barWidget.schema.find(f => f.key === "servers").label
  for (const form of ["host", "host:port", "host=Nickname"]) {
    assert.ok(label.includes(form), `the settings label omits ${form}: ${label}`)
  }
})

// ── The two blocking defects, which had tests that could not see them ──

test("configError actually produces a message, not a thrown binding", () => {
  // Model.clampField was CALLED by Service.qml and never defined in Model.js
  // -- carried over from a sibling plugin from memory. The binding threw, QML
  // left configError empty, and the bad-address message never appeared: the
  // exact silent drop the feature exists to end.
  //
  // The old test asserted both halves of the wiring (the parser rejects, the
  // panel reads the property) and never the function joining them. This
  // evaluates the real expression.
  assert.equal(typeof Model.clampField, "function", "Model.clampField does not exist")

  const at = SERVICE.indexOf("readonly property string configError:")
  assert.notEqual(at, -1, "the configError property could not be found")
  const expr = SERVICE.slice(SERVICE.indexOf(":", at) + 1, SERVICE.indexOf("\n\n", at))

  const evaluate = (rejected) => new Function("Model", "configured",
    "return (" + expr.trim() + ")")(Model, { rejected: rejected })

  assert.equal(evaluate([]), "", "an empty reject list must say nothing")
  const one = evaluate(["host|x"])
  assert.ok(one.length > 0 && one.includes("host|x"), `no message for one bad address: ${one}`)
  const two = evaluate(["a|b", "c&d"])
  assert.ok(two.includes("a|b") && two.includes("c&d"), `no message for two: ${two}`)
  // And it must be clamped rather than unbounded.
  const many = evaluate(Array.from({ length: 200 }, (_, i) => "bad|" + i))
  assert.ok(many.length <= 200, `an unbounded error message: ${many.length} chars`)
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
  for (const runtime of Object.keys(Model.RUNTIMES)) {
    for (const body of hostile) {
      assert.doesNotThrow(() => Model.readSample(runtime, body),
        `${runtime} threw on ${JSON.stringify(body.slice(0, 30))}`)
    }
  }
  // The specific reachable case: an openai node on its second poll.
  assert.equal(Model.readSample("openai", '{"object":"list","data":[]}\nnull\n'), null)
})

test("Probe.parse survives a hostile body and clamps the port", () => {
  // parseInt on unbounded digits stringifies as "1e+30" straight back into the
  // next URL.
  assert.equal(Probe.parse(Model, "", 1000), null)
  assert.equal(Probe.parse(Model, "   \n  ", 1000), null)
  assert.equal(Probe.parse(Model, "nothing recognisable", 1000), null)

  const ok = Probe.parse(Model, "PORT 8000\nRT vllm\nvllm:x 1", 1000)
  assert.equal(ok.port, 8000)
  assert.equal(ok.runtime, "vllm")

  for (const bad of ["0", "65536", "99999999999999999999999999999999"]) {
    const r = Probe.parse(Model, "PORT " + bad + "\nRT vllm\nvllm:x 1", 1000)
    assert.equal(r.port, null, `port ${bad} was accepted`)
  }
})

// ── Constants and QML-only defences, which no JS test could see ──────

test("every Text that renders anything declares PlainText", () => {
  // The README's headline safety claim, and NOTHING enforced it: deleting all
  // seven declarations left the whole suite green. QML is parsed by no tool in
  // this repo, so a Text added later is the defence most likely to be lost
  // silently.
  for (const file of ["Panel.qml", "FleetIcon.qml"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    const declared = (src.match(/\bText\s*\{/g) || []).length
    const plain = (src.match(/textFormat:\s*Text\.PlainText/g) || []).length
    assert.equal(plain, declared,
      `${file}: ${declared} Text blocks but ${plain} declare PlainText`)
    assert.ok(!/Text\.AutoText|Text\.RichText|Text\.StyledText/.test(src),
      `${file} renders markup`)
  }
})

test("the ceilings are sane values, not merely referenced ones", () => {
  // The old assertions checked that the constant was USED. Raising
  // MAX_PROBE_BYTES to a gigabyte or the timeout past the watchdog left the
  // suite green, because "is it the shared constant" says nothing about
  // whether the constant still means anything.
  assert.equal(Model.MAX_PROBE_BYTES, 65536)
  assert.ok(Model.MAX_PROBE_BYTES >= 4096 && Model.MAX_PROBE_BYTES <= 1048576,
    "a ceiling this size is not a ceiling")

  // The probe bound must fire before the 15s watchdog, with room to spare --
  // 14 races it.
  assert.ok(Model.PROBE_TIMEOUT_SEC <= 13,
    `${Model.PROBE_TIMEOUT_SEC}s races the 15s watchdog`)
  assert.ok(Model.PROBE_TIMEOUT_SEC >= 5, "too short to survive a slow first sweep")

  // And each individual request stays bounded too.
  const script = renderProbe("10.0.0.1", null)
  assert.ok(/--max-time \d+/.test(script), "curl has no per-request time bound")
  const t = parseInt(script.match(/--max-time (\d+)/)[1])
  assert.ok(t >= 1 && t <= 10, `--max-time ${t} is not a bound`)
})

test("the runtime table and the port sweep cannot drift apart", () => {
  // Two sources of one fact. PORT_CANDIDATES is a separate literal from the
  // per-runtime `port` fields, kept in step by hand.
  for (const key of Object.keys(Model.RUNTIMES)) {
    const rt = Model.RUNTIMES[key]
    if (!rt.port) continue
    assert.ok(Model.PORT_CANDIDATES.indexOf(rt.port) !== -1,
      `${key} defaults to port ${rt.port}, which the sweep never tries`)
  }
})

test("avgMetric reads the value, not a trailing timestamp", () => {
  // The Prometheus text format allows an optional timestamp after the value.
  // Reading the LAST whitespace field turned "0.5 1700000000000" into 1.7e12,
  // rendered as "170000000000000% cache". sumMetric, this function's near-twin,
  // always read the first -- the two had drifted in the one line where they
  // differ.
  const stamped = 'vllm:kv_cache_usage_perc{model_name="m"} 0.5 1700000000000'
  assert.equal(Model.avgMetric(stamped, "vllm:kv_cache_usage_perc"), 0.5)
  assert.equal(Model.sumMetric(stamped, "vllm:kv_cache_usage_perc"), 0.5,
    "the two readers must agree on where the value is")

  // A gauge can never leave 0..1 and reach the panel as a percentage.
  const body = [0.4, 0.6].map((v, i) =>
    `vllm:kv_cache_usage_perc{engine="${i}"} ${v} 1700000000000`).join("\n")
    + '\nvllm:generation_tokens_total{engine="0"} 5.0'
  const cache = Model.readSample("vllm", body).cache
  assert.ok(cache >= 0 && cache <= 1, `a fraction left its range: ${cache}`)
  assert.equal(cache, 0.5)
})

test("the Ollama path takes the tail before clamping, like the metrics path", () => {
  // Fixed for vLLM and still live here: hf.co/... names are ordinary in
  // Ollama, and clamping first let the prefix eat the budget.
  const body = JSON.stringify({ models: [{
    name: "hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    expires_at: "2026-01-01T00:00:00Z" }] })
  const model = Model.readSample("ollama", body).model
  assert.ok(!model.startsWith("hf.co"), `the vendor prefix survived: ${model}`)
  assert.ok(model.startsWith("Qwen3-Coder"), `the tail was cut: ${model}`)
  assert.ok(model.length <= Model.MAX_LABEL)

  // Both paths must agree on the rule.
  const viaMetrics = Model.modelFromMetrics(
    'vllm:x{model_name="hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M"} 0')
  assert.equal(model, viaMetrics, "the two model paths disagree on shortening")
})

test("a detected node is cached even when no sample could be parsed", () => {
  // Caching only on a successful sample meant a node that answered but yielded
  // nothing usable was never remembered, so the full sweep -- five ports times
  // three endpoints -- re-ran every refresh: five requests a second against
  // that host, indefinitely, while the panel showed it reachable and idle.
  const finish = extractFunction("_finish")
  const code = finish.split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
  const at = code.indexOf("_state[host] = {")
  assert.notEqual(at, -1, "the cache write could not be found")
  // The write must not sit behind a sample check.
  const before = code.slice(Math.max(0, at - 200), at)
  assert.ok(!/if \(sample\)[^\n]*$/.test(before.trim()),
    "the cache write is conditional on a sample again")
  assert.ok(/sample: sample \|\| null/.test(code),
    "the cached entry does not tolerate a missing sample")
})

// ── Every adapter, against a body in its documented shape ────────────
// The support claim in the README rests on these. vLLM and Ollama have been
// run; llama.cpp, SGLang and TGI have not -- their series names are confirmed
// against upstream (llama.cpp's own test suite, SGLang's production-metrics
// reference, TGI's router source) and these exercise the adapters against
// bodies in that shape. That is weaker than running them, and the `verified`
// field and the README both say so.

const BODIES = {
  llamacpp: [
    "# HELP llamacpp:tokens_predicted_total Number of generated tokens",
    "# TYPE llamacpp:tokens_predicted_total counter",
    "llamacpp:tokens_predicted_total 1250",
    "# TYPE llamacpp:requests_processing gauge",
    "llamacpp:requests_processing 2",
    "# TYPE llamacpp:requests_deferred gauge",
    "llamacpp:requests_deferred 1",
    "llamacpp:prompt_tokens_total 900"
  ].join("\n"),
  sglang: [
    "# TYPE sglang:generation_tokens_total counter",
    'sglang:generation_tokens_total{model_name="qwen"} 4400.0',
    'sglang:num_running_reqs{model_name="qwen"} 3.0',
    'sglang:num_queue_reqs{model_name="qwen"} 2.0',
    'sglang:cache_hit_rate{model_name="qwen"} 0.5'
  ].join("\n"),
  tgi: [
    "# TYPE tgi_request_generated_tokens histogram",
    'tgi_request_generated_tokens_bucket{le="1"} 0',
    "tgi_request_generated_tokens_sum 8123",
    "tgi_request_generated_tokens_count 44",
    "# TYPE tgi_batch_current_size gauge",
    "tgi_batch_current_size 4",
    "# TYPE tgi_queue_size gauge",
    "tgi_queue_size 7"
  ].join("\n")
}

test("every metrics runtime is detected from a body in its real shape", () => {
  for (const [runtime, body] of Object.entries(BODIES)) {
    assert.equal(Model.detectFromMetrics(body), runtime,
      `${runtime} is not detected from its own exposition`)
  }
})

test("every metrics runtime yields a usable sample", () => {
  const expected = {
    llamacpp: { work: 1250, running: 2, waiting: 1 },
    sglang:   { work: 4400, running: 3, waiting: 2 },
    tgi:      { work: 8123, running: 4, waiting: 7 }
  }
  for (const [runtime, body] of Object.entries(BODIES)) {
    const s = Model.readSample(runtime, body)
    assert.ok(s, `${runtime} produced no sample`)
    assert.equal(s.work, expected[runtime].work, `${runtime} work`)
    assert.equal(s.running, expected[runtime].running, `${runtime} running`)
    assert.equal(s.waiting, expected[runtime].waiting, `${runtime} waiting`)
  }
})

test("every runtime's filter keeps the series its adapter reads", () => {
  // The filter decides what the probe returns at all -- a series missing from
  // it can never be read however correct the parser is. This is how the vLLM
  // activity signal was silently dead once before.
  const cp = require("node:child_process")
  for (const [runtime, body] of Object.entries(BODIES)) {
    const script = renderProbe("10.0.0.1", { port: 8000, runtime: runtime })
    const m = script.match(/\| (grep -E '[^']*')/)
    assert.ok(m, `${runtime} probe does not filter`)
    const out = cp.spawnSync("bash", ["-c", m[1]], { input: body, encoding: "utf8" }).stdout
    const s = Model.readSample(runtime, out)
    assert.ok(s, `${runtime}: the filter discarded what the parser needs`)
    assert.equal(s.work, Model.readSample(runtime, body).work,
      `${runtime}: filtered and unfiltered disagree`)
  }
})

test("the verified level is one of the ones the README explains", () => {
  // The README's support table is generated from these by hand. A new value
  // here without a matching row there is how a support claim drifts.
  const allowed = ["live", "names", "n/a"]
  for (const [key, rt] of Object.entries(Model.RUNTIMES)) {
    assert.ok(allowed.indexOf(rt.verified) !== -1,
      `${key} claims verification level ${JSON.stringify(rt.verified)}`)
  }
  // Only what has actually been run may claim "live".
  assert.equal(Model.RUNTIMES.vllm.verified, "live")
  assert.equal(Model.RUNTIMES.ollama.verified, "live")
  for (const k of ["llamacpp", "sglang", "tgi"]) {
    assert.equal(Model.RUNTIMES[k].verified, "names",
      `${k} has never been run and must not claim otherwise`)
  }
})

// ── Structure guards ─────────────────────────────────────────────────
// The layout is the point, not an accident, and QML is parsed by no tool in
// this repo -- so the shape has to be asserted here or it will drift back.

test("no QML file carries pure logic that belongs in JS", () => {
  // Logic in QML can only be reached by tests through a source extractor, and
  // both of the worst defects found in review lived in exactly that region.
  const budgets = { "Service.qml": 340, "Panel.qml": 260, "NodeRow.qml": 200, "ColumnWidths.qml": 140 }
  for (const [file, max] of Object.entries(budgets)) {
    const n = fs.readFileSync(path.join(__dirname, "..", file), "utf8").split("\n").length
    assert.ok(n <= max, `${file} is ${n} lines, over its ${max}-line budget — split it`)
  }
})

test("the row does not measure for itself", () => {
  // Every row is handed identical widths so the columns line up. A row that
  // measured would drift the moment two nicknames differed in length.
  const row = fs.readFileSync(path.join(__dirname, "..", "NodeRow.qml"), "utf8")
  assert.ok(!/TextMetrics/.test(row), "NodeRow measures text itself")
  assert.ok(!/\broot\./.test(row), "NodeRow still reaches into a parent by id")
  for (const p of ["labelWidth", "hostWidth", "runtimeWidth", "stateWidth", "rowContentWidth"]) {
    assert.ok(new RegExp("property real " + p).test(row), `NodeRow does not take ${p}`)
  }
})

test("an unknown column measures nothing rather than the wrong thing", () => {
  // _widest dispatched on a string with the runtime label as its default, so a
  // typo silently measured the wrong field.
  const src = fs.readFileSync(path.join(__dirname, "..", "ColumnWidths.qml"), "utf8")
  const fn = src.slice(src.indexOf("function _widest"))
  assert.ok(/else \{\s*\n\s*return ""/.test(fn),
    "an unknown column name still falls through to a default")
})

test("stateLabel is one definition, used by both the row and the measurement", () => {
  // It lived in Panel.qml, where the row and the column measurement each
  // needed it and only a source extractor could test it.
  assert.equal(typeof Model.stateLabel, "function")
  for (const file of ["NodeRow.qml", "ColumnWidths.qml"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    assert.ok(/Model\.stateLabel\(/.test(src), `${file} does not use the shared state label`)
  }
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  assert.ok(!/function stateTextFor/.test(panel), "the old copy is back in Panel.qml")
})

// ── The minor list from review ───────────────────────────────────────

test("a host listed twice is probed once", () => {
  // Two entries share a single _state key, so the second result of each cycle
  // overwrote the first's sample and the activity delta was measured against
  // the wrong reading: work reported that had not happened, or missed.
  assert.deepEqual(runConfiguredServers("10.0.0.1, 10.0.0.1"),
    [{ host: "10.0.0.1", label: "" }])
  // First mention wins, so the name you gave it survives.
  assert.deepEqual(runConfiguredServers("10.0.0.1=Big Box, 10.0.0.1=Other"),
    [{ host: "10.0.0.1", label: "Big Box" }])
  // A port makes it a different endpoint, and stays separate.
  assert.equal(runConfiguredServers("10.0.0.1, 10.0.0.1:8000").length, 2)
  // Ordinary lists are untouched.
  assert.equal(runConfiguredServers("10.0.0.1, 10.0.0.2, 10.0.0.3").length, 3)
})

test("the panel publishes every verb the base Panel does", () => {
  // Replacing the base handler quietly dropped show and hide, which every
  // shipped plugin has.
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  const base = fs.readFileSync("/usr/share/omarchy/shell/Ui/Panel.qml", "utf8")
  const verbs = (src) => new Set((src.match(/function (\w+)\(\): void/g) || [])
    .map(m => m.match(/function (\w+)/)[1]))
  const ours = verbs(panel), theirs = verbs(base)
  for (const v of theirs) {
    assert.ok(ours.has(v), `the base Panel publishes ${v}() and this one does not`)
  }
})

test("a fractional token delta is rounded before it is shown", () => {
  // TGI's work counter is a histogram _sum and is genuinely a float, so a
  // delta arrives as 3.000000000000001 -- rendered literally, and at 31
  // characters wider than the column had been sized for.
  const messy = Model.activityBetween({ work: 1.0 }, { work: 4.000000000000001 })
  assert.equal(Model.stateLabel({ reachable: true, activity: messy }), "working  3 tok")
  // Under a whole token there is no count worth printing.
  assert.equal(Model.stateLabel({ reachable: true, activity: { active: true, amount: 0.4 } }),
    "working")
  // Whole numbers are unchanged.
  assert.equal(Model.stateLabel({ reachable: true, activity: { active: true, amount: 42 } }),
    "working  42 tok")
  // And the state column is still sized for what it can hold.
  assert.ok("working  9999 tok".length >= "working  3 tok".length)
})

test("every width the row declares is both used by it and wired by the panel", () => {
  // Asserting that the pieces EXIST is not asserting they are connected --
  // exactly the shape of the clampField defect, where both halves of the
  // wiring were tested and the function joining them was not. Setting
  // `width: labelWidth` to a literal, or `labelWidth: widths.label` to 0, both
  // passed a suite that checked the properties were declared.
  const row = fs.readFileSync(path.join(__dirname, "..", "NodeRow.qml"), "utf8")
  const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

  const declared = [...row.matchAll(/property real (\w+)/g)].map(m => m[1])
  assert.ok(declared.length >= 5, `expected the width properties, saw ${declared}`)

  for (const p of declared) {
    // Used for something, not merely declared.
    const uses = [...row.matchAll(new RegExp("\\b" + p + "\\b", "g"))].length
    assert.ok(uses >= 2, `NodeRow declares ${p} and never uses it`)

    // And the panel must hand it a real measurement, not a literal.
    const wired = panel.match(new RegExp(p + ":\\s*([^\\n]+)"))
    assert.ok(wired, `Panel.qml never wires ${p}`)
    assert.ok(/widths\./.test(wired[1]),
      `Panel.qml wires ${p} to ${wired[1].trim()} instead of a measured width`)
  }
})

test("the row's own columns are bound to the widths it was given", () => {
  // The four column Texts must take their width from the passed-in property.
  const row = fs.readFileSync(path.join(__dirname, "..", "NodeRow.qml"), "utf8")
  for (const p of ["labelWidth", "hostWidth", "runtimeWidth", "stateWidth"]) {
    assert.ok(new RegExp("width:\\s*" + p + "\\b").test(row),
      `no column is sized by ${p}`)
  }
  // And no column may carry a hardcoded pixel width.
  const literals = [...row.matchAll(/width:\s*(\d+)\s*$/gm)].map(m => m[1])
  assert.deepEqual(literals, [], `hardcoded column widths: ${literals}`)
})
