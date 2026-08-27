// The shell probe: what it asks for, what it is allowed to spend, and what it
// is allowed to believe about the answer.
//
// Quickshell's output collector has no size limit of its own, so every branch
// is bounded in the shell BEFORE the bytes reach QML -- and the deadline is
// derived from the script rather than written beside it, because the two once
// disagreed badly enough that no host was discoverable unless it answered on
// the first candidate port.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { Runtimes, Metrics, Poll, Probe, Reading, readingOf, renderProbe, sourceOf, codeOf, codeLines } = require("./harness.js")
const { BODIES, bigMetricsBody } = require("./fixtures.js")
const { SERVICE, extractFunction } = require("./qml.js")


// Count the worst case back OUT of the generated script, rather than trusting
// the constants that produced it: budget and spend derive from the same
// numbers, so a relative check moves with them and catches nothing.
// `command -v curl` names curl without running it, so it is not a request and
// not a thing to bound. Excluded by LINE rather than by narrowing the patterns
// below: those are deliberately broad, because their job is to notice a curl
// somebody adds later without thinking about ceilings.
function withoutTheCurlPresenceCheck(script) {
  return script.split("\n").filter(l => !/command -v curl/.test(l)).join("\n")
}

function worstCaseSec(script) {
  script = withoutTheCurlPresenceCheck(script)
  const perRequest = parseInt(script.match(/--max-time (\d+)/)[1], 10)
  const loop = script.match(/for p in ([^;]+); do([\s\S]*?)\ndone/)
  const requests = loop
    ? loop[1].trim().split(/\s+/).length * (loop[2].match(/curl /g) || []).length
    : (script.match(/curl /g) || []).length
  return { perRequest: perRequest, requests: requests, total: perRequest * requests }
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
  assert.ok(out.length <= Runtimes.MAX_PROBE_BYTES, "the output is not bounded")

  const sample = Metrics.readSample("vllm", out)
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
  assert.ok(out.length <= Runtimes.MAX_PROBE_BYTES, `unbounded output: ${out.length} bytes`)
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
    const curls = withoutTheCurlPresenceCheck(script).match(/curl [^\n]*/g) || []
    assert.ok(curls.length > 0, `${name} probe runs no curl at all`)
    for (const c of curls) {
      // A curl is acceptable if it is byte-bounded, OR if it discards its
      // output entirely -- the liveness check writes to /dev/null and exists
      // only for its exit status, so nothing it fetches can reach the
      // collector. Anything else is unbounded.
      const discards = /-o \/dev\/null/.test(c)
      const bounded = /head -c \d+/.test(c)
      assert.ok(bounded || discards, `${name}: unbounded curl -> ${c.slice(0, 110)}`)
      if (bounded) {
        const cap = parseInt(c.match(/head -c (\d+)/)[1])
        assert.equal(cap, Runtimes.MAX_PROBE_BYTES, `${name}: magic number, not the shared ceiling`)
      }
    }
    // And the whole script is bounded as one, so a future branch inherits it.
    assert.ok(new RegExp("\\}\\s*\\| head -c " + Runtimes.MAX_PROBE_BYTES + "\\s*$").test(script.trim()),
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
  // The fetching curl's pipeline, up to the end of its bound -- the script now
  // also contains a liveness curl that fetches nothing.
  const m = script.match(/\| (grep -E '[^']*') \| (head -c \d+)/)
  assert.ok(m, `the known-node fetch is not filtered and bounded: ${script}`)
  const pipe = "| " + m[1] + " | " + m[2]
  const flood = 'vllm:num_requests_running{model_name="m"} 1.0\n'.repeat(300000)
  const r = cp.spawnSync("bash", ["-c", `cat ${pipe}`],
    { input: flood, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ""
  assert.ok(out.length > 0, "the fixture produced nothing")
  assert.ok(out.length <= Runtimes.MAX_PROBE_BYTES,
    `${out.length} bytes reached the collector from a ${flood.length}-byte flood`)
})

test("the collector read is clamped as well as the probe", () => {
  // Defence in depth, and it needs a guard or it is a line nobody can tell is
  // missing. The probe script is the real bound; this means no parser can be
  // handed more than the ceiling even if a future probe path forgets one --
  // which is exactly what happened to the known-node probe.
  // The clamp moved into Probe.parse, where it can be tested by calling it.
  assert.equal(Probe.parse("PORT 8000\nRT vllm\n" + "x".repeat(200000),
    Runtimes.MAX_PROBE_BYTES).body.length <= Runtimes.MAX_PROBE_BYTES, true,
    "Probe.parse does not clamp what it is handed")
  // And the assembler Service hands the collector's text to uses that ceiling
  // rather than one of its own -- executed, not read off the source.
  const huge = "PORT 8000\nRT vllm\nvllm:generation_tokens_total 3\n" + "x".repeat(200000)
  assert.ok(readingOf(huge, {}).node.reachable,
    "an oversized body was dropped instead of clamped")
  assert.ok(/Probe\.parse\(out\)/.test(codeOf("lib/Reading.js")),
    "the collector read does not go through the clamped parser")
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
  assert.ok(new RegExp("for p in " + Runtimes.PORT_CANDIDATES.join(" ")).test(bare),
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
  const sample = Metrics.readSample("vllm", out)
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
    assert.ok(out.length <= Runtimes.MAX_PROBE_BYTES,
      `${out.length} bytes reached the collector against a ceiling of ${Runtimes.MAX_PROBE_BYTES}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
  const src = sourceOf("lib/Probe.js")
  const code = src.split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
  assert.ok(!/replace\(\/:\/g/.test(code), "the no-op replace is back")
  assert.ok(/\^\[A-Za-z0-9_:\]\+\$/.test(code), "prefixes reach the shell unvalidated")
  assert.ok(/prefixes\[pi\]/.test(code), "nothing iterates the prefixes to validate them")
})

test("Probe.parse survives a hostile body and clamps the port", () => {
  // parseInt on unbounded digits stringifies as "1e+30" straight back into the
  // next URL.
  assert.equal(Probe.parse("", 1000), null)
  assert.equal(Probe.parse("   \n  ", 1000), null)
  assert.equal(Probe.parse("nothing recognisable", 1000), null)

  const ok = Probe.parse("PORT 8000\nRT vllm\nvllm:x 1", 1000)
  assert.equal(ok.port, 8000)
  assert.equal(ok.runtime, "vllm")

  for (const bad of ["0", "65536", "99999999999999999999999999999999"]) {
    const r = Probe.parse("PORT " + bad + "\nRT vllm\nvllm:x 1", 1000)
    assert.equal(r.port, null, `port ${bad} was accepted`)
  }
})

test("the ceilings are sane values, not merely referenced ones", () => {
  // The old assertions checked that the constant was USED. Raising
  // MAX_PROBE_BYTES to a gigabyte or the timeout past the watchdog left the
  // suite green, because "is it the shared constant" says nothing about
  // whether the constant still means anything.
  assert.equal(Runtimes.MAX_PROBE_BYTES, 65536)
  assert.ok(Runtimes.MAX_PROBE_BYTES >= 4096 && Runtimes.MAX_PROBE_BYTES <= 1048576,
    "a ceiling this size is not a ceiling")

  // Each individual request stays bounded too.
  const script = renderProbe("192.0.2.10", null)
  assert.ok(/--max-time \d+/.test(script), "curl has no per-request time bound")
  const t = parseInt(script.match(/--max-time (\d+)/)[1])
  assert.ok(t >= 1 && t <= 10, `--max-time ${t} is not a bound`)
})

test("a probe's deadline covers what the probe can actually spend", () => {
  // This exact arithmetic was wrong, and nothing noticed: discovery made
  // fifteen requests at four seconds each -- sixty seconds -- under a
  // twelve-second `timeout --signal=KILL`. Measured with one unresponsive port
  // ahead of a live one, the sweep was KILLed at 12.006s having never reached
  // the second port, so a host that did not answer promptly on 8000 could not
  // be discovered at all and was drawn "unreachable" while serving.
  const cases = [
    ["192.0.2.10", { port: 8000, runtime: "vllm" }, "a known node"],
    ["192.0.2.10:8000", null, "an explicit port"],
    ["192.0.2.10", null, "a full sweep"],
  ]
  for (const [host, known, what] of cases) {
    const spend = worstCaseSec(Probe.script(host, known))
    const budget = Probe.budgetSec(host, known)
    assert.ok(budget >= spend.total,
      `${what}: ${spend.requests} requests x ${spend.perRequest}s = ` +
      `${spend.total}s under a ${budget}s kill`)
    // And not absurdly generous either, or it is not a deadline. Both bounds
    // are needed: budget and spend are derived from the same constants, so
    // relative checks alone move together and catch nothing. This one is
    // absolute -- the widget refreshes every few seconds, and a deadline the
    // user waits a minute for is a hang with a timer on it.
    assert.ok(budget <= spend.total + 10, `${what}: ${budget}s is not a deadline`)
    assert.ok(budget <= 40, `${what}: a ${budget}s probe stalls the whole panel`)
  }

  // A filtered port hangs at connect, where --max-time is not what binds.
  assert.ok(/--connect-timeout \d+/.test(Probe.script("192.0.2.10", null)),
    "a host that drops packets is bounded only by --max-time")

  // Each slot carries ITS OWN deadline, derived from the script that slot is
  // about to run. A fleet-wide one abandoned a discovery sweep still well
  // inside its budget because a known node beside it had already finished.
  const svc = codeOf("Service.qml")
  assert.ok(/deadlineMs = Date\.now\(\) \+ \(budget \+ \d+\) \* 1000/.test(svc),
    "the deadline is a fixed interval again, not this probe's own budget")
  assert.ok(/var budget = Probe\.budgetSec\(host, known\)/.test(svc),
    "the deadline is not derived from the script the probe will run")

  // And the rule that reads it, executed rather than matched.
  const slot = { running: true, abandoned: false, deadlineMs: 10000 }
  assert.equal(Poll.pollAction(slot, 9999), "skip",
    "a probe still inside its own deadline was interrupted")
  assert.equal(Poll.pollAction(slot, 10001), "kill",
    "a probe past its deadline was left running forever")
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
    const s = Metrics.readSample(runtime, out)
    assert.ok(s, `${runtime}: the filter discarded what the parser needs`)
    assert.equal(s.work, Metrics.readSample(runtime, body).work,
      `${runtime}: filtered and unfiltered disagree`)
  }
})

test("a known node that stops answering is reported unreachable, not idle", () => {
  // The worst defect this plugin has had. The PORT/RT markers were echoed
  // unconditionally, BEFORE curl ran, so every failure of a known node
  // (refused, timeout, DNS, 5xx, the kill timer firing) still produced
  // "PORT n\nRT vllm\n" -- which parses as a perfectly good reading. The row
  // said "idle" in green, the warning badge never lit, and diagnostics
  // reported reachable:true. A box that lost power looked exactly like a
  // healthy quiet one, forever.
  const cp = require("node:child_process"), net = require("node:net")
  // A port nothing is listening on.
  const srv = net.createServer()
  let port
  const done = new Promise(r => srv.listen(0, "127.0.0.1", () => { port = srv.address().port; srv.close(r) }))
  return done.then(() => {
    const script = renderProbe("127.0.0.1:" + port, { port: port, runtime: "vllm" })
    const out = cp.spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 25000 }).stdout || ""
    assert.equal(out.trim(), "", `a dead node still produced: ${JSON.stringify(out)}`)
    assert.equal(Probe.parse(out, Runtimes.MAX_PROBE_BYTES), null,
      "a dead node parsed as a reading")
  })
})

test("the markers are never emitted before something answers", () => {
  // The structural form of the same bug: on every path, our PORT/RT echo must
  // sit inside a branch that already proved the endpoint replied.
  for (const known of [null, { port: 8000, runtime: "vllm" }]) {
    const script = codeLines(renderProbe("10.0.0.1", known))
    const firstEcho = script.search(/echo "PORT/)
    const firstCurl = script.search(/curl /)
    assert.ok(firstCurl !== -1, "no curl in the script")
    assert.ok(firstCurl < firstEcho,
      `markers are echoed before any curl runs: ${script.slice(0, 120)}`)
  }
})

test("a server that answers but publishes nothing readable emits NOSAMPLE", () => {
  // The liveness branch. Replacing it with `elif false` left the whole suite
  // green: the parse side was tested against the literal marker, and nothing
  // checked that the SCRIPT ever produces it. Without it, an alive server whose
  // metrics do not match the filter collapses into "down".
  const cp = require("node:child_process"), os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-nosample-"))
  try {
    // Answers 200 with a body carrying none of the series the filter keeps.
    fs.writeFileSync(path.join(dir, "curl"),
      '#!/bin/bash\n' +
      'for a in "$@"; do [ "$a" = "-o" ] && exit 0; done\n' +
      'printf "# HELP something_else help\\nsomething_else 1\\n"\n')
    fs.chmodSync(path.join(dir, "curl"), 0o755)

    const script = renderProbe("10.0.0.1:8000", { port: 8000, runtime: "vllm" })
    const out = cp.spawnSync("/usr/bin/bash", ["-c", script], {
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
      encoding: "utf8", timeout: 20000
    }).stdout || ""

    assert.ok(/^NOSAMPLE$/m.test(out), `alive-but-unreadable did not emit NOSAMPLE: ${JSON.stringify(out)}`)
    const read = Probe.parse(out, Runtimes.MAX_PROBE_BYTES)
    assert.ok(read, "NOSAMPLE did not parse as a reading")
    assert.equal(read.runtime, "vllm")
    assert.equal(Metrics.readSample(read.runtime, read.body), null,
      "an empty body produced a sample")

    // And a server that is actually down still emits nothing at all.
    fs.writeFileSync(path.join(dir, "curl"), "#!/bin/bash\nexit 7\n")
    fs.chmodSync(path.join(dir, "curl"), 0o755)
    const down = cp.spawnSync("/usr/bin/bash", ["-c", script], {
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
      encoding: "utf8", timeout: 20000
    }).stdout || ""
    assert.equal(down.trim(), "", `a dead server produced: ${JSON.stringify(down)}`)
    assert.equal(Probe.parse(down, Runtimes.MAX_PROBE_BYTES), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a server cannot forge the NOSAMPLE marker", () => {
  // Our own bytes precede the server's on every branch, so a body containing
  // the word cannot make a healthy reading look unreadable -- but the marker
  // is matched with ^...$ multiline, so check it directly.
  const forged = "PORT 8000\nRT vllm\nvllm:generation_tokens_total 5\nNOSAMPLE\n"
  const read = Probe.parse(forged, Runtimes.MAX_PROBE_BYTES)
  // It IS seen -- which is why the branch that emits it must be the only way a
  // body reaches us without a sample. Confirm the sample still wins.
  const sample = Metrics.readSample(read.runtime, read.body)
  assert.ok(sample, "a real sample beside a forged marker was lost")
  assert.equal(sample.work, 5, "the real series must still be read")
})

test("a cached runtime with no adapter cannot wedge the widget", () => {
  // _state can carry a runtime name written by an older version of this file.
  // Every caller must handle runtimeOf() returning null: dereferencing it here
  // throws out of the poll, and the host is never probed again.
  assert.equal(Runtimes.runtimeOf("a-runtime-that-was-removed"), null)
  const script = Probe.script("192.0.2.10", { port: 8000, runtime: "a-runtime-that-was-removed" })
  assert.equal(script, "", "an unknown cached runtime built a probe out of null")
  // And an empty script is handled rather than run: it yields no markers, so
  // the reading is "unreachable" for that poll and discovery resumes.
  assert.equal(Probe.parse("", Runtimes.MAX_PROBE_BYTES), null)
})
