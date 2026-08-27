// One probe result in, one row out -- and what that row may say.
//
// Every branch here exists because "idle" is a claim about work. A node that
// answered with nothing readable, a node whose counter restarted, and a node
// that did not answer at all are three different things, and none of them is
// idle.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { Metrics, Fleet, Probe, readingOf, renderProbe } = require("./harness.js")
const { runPanelDetail } = require("./qml.js")

test("a detected node is cached even when no sample could be parsed", () => {
  // Caching only on a successful sample meant a node that answered but yielded
  // nothing usable was never remembered, so the full sweep -- five ports times
  // three endpoints -- re-ran every refresh: five requests a second against
  // that host, indefinitely, while the panel showed it reachable and idle.
  // Answered on 8000 as vLLM, published nothing this adapter can read.
  const res = readingOf("PORT 8000\nRT vllm\nNOSAMPLE\n", {})
  assert.ok(res.state, "a detected node was not cached, so the sweep re-runs")
  assert.equal(res.state.runtime, "vllm", "the detected runtime was not kept")
  assert.equal(res.state.port, 8000, "the detected port was not kept")
  assert.equal(res.state.sample, null, "a missing sample was not tolerated")

  // The next cycle then probes the known port instead of sweeping.
  assert.ok(!/for p in/.test(Probe.script("192.0.2.10", res.state)),
    "the cached entry did not stop the full port sweep")
})

test("answered-but-unreadable is distinct from both a sample and silence", () => {
  // Collapsing it into "idle" is how a saturated node gets drawn as quiet;
  // collapsing it into "down" hides a server that is plainly alive.
  // Three bodies, all reachable, none readable -- the marker only sees the
  // first, which is why the rule downstream is the sample and not the marker.
  const unreadable = [
    "PORT 8000\nRT vllm\nNOSAMPLE\n",              // published nothing
    "PORT 8000\nRT vllm\nvllm:x_created 1\n",      // prefix-matched the filter
    "PORT 11434\nRT ollama\n<html>nope</html>\n",  // port now serves something else
  ]
  for (const text of unreadable) {
    const read = Probe.parse(text, 9999)
    assert.ok(read, `a live server parsed as silence: ${text}`)
    assert.ok(!/NOSAMPLE/.test(read.body), "the marker leaked into the body")
    assert.equal(Metrics.readSample(read.runtime, read.body), null,
      `an unreadable body produced a sample: ${text}`)
  }

  // A readable one still reads, or the check above proves nothing.
  const withSample = Probe.parse("PORT 8000\nRT vllm\nvllm:generation_tokens_total 5\n", 9999)
  assert.ok(Metrics.readSample(withSample.runtime, withSample.body), "a real sample stopped reading")

  assert.equal(Probe.parse("", 9999), null)

  // And the assembler must turn a null sample into an honest label, not
  // "idle". The rule is the SAMPLE, not the marker: NOSAMPLE only fires on an
  // empty body, so keying off it left a node answering with a non-empty but
  // unreadable body falling through every branch and drawn green.
  for (const text of unreadable) {
    const res = readingOf(text, {})
    assert.equal(res.node.reachable, true, `a live server was drawn as down: ${text}`)
    assert.equal(res.node.canReportActivity, false,
      `an unreadable body was drawn as idle: ${text}`)
    assert.equal(Fleet.stateLabel(res.node), "no activity signal",
      `the row does not say so: ${text}`)
  }
})

test("an error page is not a reading", () => {
  // curl -f. Without it a 500 whose body happens to contain a kept series --
  // an nginx error page from a proxy in front of a dead engine, say -- is
  // captured and drawn as a healthy sample.
  const cp = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-curlf-"))
  try {
    fs.writeFileSync(path.join(dir, "curl"),
      '#!/bin/bash\n' +
      // Behave like the real thing: with -f, fail on a 5xx and print nothing.
      // The flag arrives inside a cluster (-sSf), not on its own.
      'for a in "$@"; do case "$a" in -[!-]*f*|--fail) exit 22;; esac; done\n' +
      'printf "vllm:generation_tokens_total 5\\n"\n')
    fs.chmodSync(path.join(dir, "curl"), 0o755)

    const run = (known) => cp.spawnSync("/usr/bin/bash",
      ["-c", renderProbe("192.0.2.10:8000", known)],
      { env: { ...process.env, PATH: dir + ":" + process.env.PATH },
        encoding: "utf8", timeout: 20000 }).stdout || ""

    // The read is refused, so the series never becomes a sample. The node is
    // still ANSWERING -- the liveness check drops -f precisely so a 5xx is not
    // mistaken for a dead host -- so the honest row is "no activity signal".
    const res = readingOf(run({ port: 8000, runtime: "vllm" }), {})
    assert.equal(Fleet.stateLabel(res.node), "no activity signal",
      "an error page was drawn as a healthy sample")
    assert.strictEqual(res.state.sample, null, "an error page was cached as a sample")

    // Discovery has no liveness fallback, so there it is simply not a find.
    assert.equal(run(null).trim(), "",
      "discovery accepted a failed request as an answer")
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("a server that answers is never drawn as unreachable", () => {
  // The liveness check used to inherit -f from the read, and -f makes every
  // non-2xx an empty reply -- the same thing a dead host produces. A vLLM
  // behind an auth proxy, or one whose /metrics 500s while the engine serves,
  // was drawn urgent-red "unreachable". The README promises the opposite.
  //
  // The server runs in a CHILD process on purpose: spawnSync blocks this one's
  // event loop, so a server listening here could never answer the probe.
  const cp = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-http-"))
  const portFile = path.join(dir, "port")

  const serve = (code, headers, body) => {
    fs.writeFileSync(path.join(dir, "srv.js"),
      `const http = require("node:http"), fs = require("node:fs")\n` +
      `const s = http.createServer((q, r) => { r.writeHead(${code}, ${JSON.stringify(headers)}); r.end(${JSON.stringify(body)}) })\n` +
      `s.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)))\n`)
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile)
    const child = cp.spawn(process.execPath, [path.join(dir, "srv.js")], { stdio: "ignore" })
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
      cp.spawnSync("/usr/bin/bash", ["-c", "sleep 0.05"])
    }
    assert.ok(fs.existsSync(portFile), "the stub server never came up")
    return { child: child, port: parseInt(fs.readFileSync(portFile, "utf8"), 10) }
  }

  const probe = (port) => cp.spawnSync("/usr/bin/bash",
    ["-c", Probe.script("127.0.0.1:" + port, { port: port, runtime: "vllm" })],
    { encoding: "utf8", timeout: 20000 }).stdout || ""

  try {
    const cases = [
      [401, { "www-authenticate": 'Basic realm="m"' }, ""],
      [500, {}, "upstream failed"],
      [200, {}, "<html>up and serving</html>"],
    ]
    for (const [code, headers, body] of cases) {
      const s = serve(code, headers, body)
      try {
        const res = readingOf(probe(s.port), {})
        assert.equal(res.node.reachable, true,
          `HTTP ${code} was reported as unreachable`)
        assert.equal(Fleet.stateLabel(res.node), "no activity signal",
          `HTTP ${code} did not read as answered-but-unreadable`)
      } finally { s.child.kill() }
    }

    // A 200 carrying real series still reads as a sample, or the above proves
    // only that everything is called "answered".
    const good = serve(200, {}, 'vllm:generation_tokens_total{model="m"} 5\n')
    try {
      const res = readingOf(probe(good.port), {})
      assert.equal(Fleet.stateLabel(res.node), "measuring", "a real body stopped reading")
    } finally { good.child.kill() }

    // And nothing listening is still, correctly, unreachable.
    assert.equal(readingOf(probe(9), {}).node.reachable, false,
      "a dead port was reported as answering")
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("an outage drops the sample but keeps what was learned", () => {
  // Carrying the old sample forward would fabricate a delta against a counter
  // read minutes ago the moment the node returns -- a box that was down
  // reappearing as "working 40k tok". Dropping the runtime instead would force
  // the whole five-port sweep after every blip.
  const prev = { host: "192.0.2.10", port: 8000, runtime: "vllm",
                 sample: { work: 100, at: 1 }, lastSeenMs: 5 }
  const res = readingOf(null, prev)

  assert.equal(res.node.reachable, false)
  assert.ok(res.state, "an outage forgot a known node, forcing rediscovery")
  assert.equal(res.state.runtime, "vllm", "the known runtime was dropped")
  assert.equal(res.state.port, 8000, "the known port was dropped")
  assert.strictEqual(res.state.sample, null, "a stale sample survived an outage")
  assert.equal(res.state.lastSeenMs, 5, "an outage was recorded as a sighting")

  // And the node that comes back measures rather than claiming a delta.
  const back = readingOf("PORT 8000\nRT vllm\nvllm:generation_tokens_total 900\n", res.state)
  assert.equal(back.node.firstReading, true, "a delta was fabricated across an outage")
  assert.equal(back.node.activity.active, false)
})

test("a real sample beats a NOSAMPLE marker in the same body", () => {
  // The marker is ours, but parse sees it anywhere in the text and one runtime
  // (ollama) has no filter, so a body could in principle carry the word. It
  // must never demote a node that plainly published a reading.
  const forged = "PORT 8000\nRT vllm\nNOSAMPLE\nvllm:generation_tokens_total 7\n"
  const res = readingOf(forged, { sample: { work: 1, at: 0 } })
  assert.notEqual(res.node.canReportActivity, false,
    "a forged marker demoted a node that published a real reading")
  assert.equal(res.state.sample.work, 7, "the real reading was discarded")
})

test("a wedged server is not reported as a powered-off one", () => {
  // Both time out, and both used to be the word "unreachable" -- while the
  // README names "is it thinking, or did the server wedge?" as a question this
  // plugin exists to answer. They are different problems with different fixes.
  //
  // The discriminator is curl's %{time_connect}: a server that ACCEPTS the
  // connection and then says nothing gives exit 28 with a non-zero connect
  // time, where a refused port gives exit 7 and a dropped packet gives exit 28,
  // both with 0.000000. That is a property of curl, not of this code, so it is
  // measured against a real socket rather than asserted about the script text.
  //
  // Child process on purpose: spawnSync blocks this one's event loop, so a
  // listener here could never accept the probe's connection.
  const cp = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wedged-"))
  const portFile = path.join(dir, "port")
  fs.writeFileSync(path.join(dir, "srv.js"),
    `const net = require("node:net"), fs = require("node:fs")\n` +
    // Accept, hold the socket open, never write a byte. A wedged engine.
    `const held = []\n` +
    `const s = net.createServer(c => held.push(c))\n` +
    `s.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)))\n`)
  const child = cp.spawn(process.execPath, [path.join(dir, "srv.js")], { stdio: "ignore" })
  try {
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
      cp.spawnSync("/usr/bin/bash", ["-c", "sleep 0.05"])
    }
    assert.ok(fs.existsSync(portFile), "the wedged stub never came up")
    const port = parseInt(fs.readFileSync(portFile, "utf8"), 10)

    const run = (p) => cp.spawnSync("/usr/bin/bash",
      ["-c", Probe.script("127.0.0.1:" + p, { port: p, runtime: "vllm" })],
      { encoding: "utf8", timeout: 30000 }).stdout || ""

    const wedged = run(port)
    assert.equal(Probe.failure(wedged), "noanswer",
      `a wedged server did not report NOANSWER: ${JSON.stringify(wedged)}`)
    assert.equal(Fleet.stateLabel(readingOf(wedged, {}).node), "not responding")

    // A refused port on the same host must still be plain unreachable, or the
    // discriminator is not discriminating -- it is just always saying wedged.
    const refused = run(port + 1 > 65535 ? port - 1 : port + 1)
    assert.equal(Probe.failure(refused), null,
      `a refused port reported a failure reason: ${JSON.stringify(refused)}`)
    assert.equal(Fleet.stateLabel(readingOf(refused, {}).node), "unreachable")
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing curl blames the machine, not every server", () => {
  // Every branch redirects curl's stderr to /dev/null, so "command not found"
  // landed where nobody could see it and produced exactly what a dead host
  // produces: the whole fleet drawn "unreachable", with the real cause -- one
  // missing package on this machine -- nowhere on screen. The manifest
  // declares no dependency, so the script is the only place to catch it.
  for (const known of [{ port: 8000, runtime: "vllm" }, null]) {
    const script = Probe.script("192.0.2.10", known)
    assert.ok(/command -v curl/.test(script),
      `${known ? "known-node" : "discovery"} probe does not check curl exists`)
    // Before any request, or it is not a guard.
    assert.ok(script.indexOf("command -v curl") < script.indexOf("curl -"),
      "the check runs after the first request")
  }

  // Run it for real with a PATH that has everything except curl.
  const cp = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-nocurl-"))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  for (const tool of ["bash", "grep", "head", "env", "timeout"]) {
    const found = cp.spawnSync("command", ["-v", tool], { shell: true, encoding: "utf8" })
      .stdout.trim()
    if (found) fs.symlinkSync(found, path.join(bin, tool))
  }
  try {
    assert.ok(!fs.existsSync(path.join(bin, "curl")), "the shim directory has curl in it")
    const out = cp.spawnSync("/usr/bin/bash",
      ["-c", Probe.script("192.0.2.10", { port: 8000, runtime: "vllm" })],
      { encoding: "utf8", env: { PATH: bin }, timeout: 30000 }).stdout || ""
    assert.equal(Probe.failure(out), "notool", `expected NOTOOL, got ${JSON.stringify(out)}`)

    // The row is UN-PROBED, not failed: nothing here could ask it anything.
    // It must not read "unreachable" -- the word a powered-off box gets -- and
    // it does not get a state of its own either, because a missing curl is one
    // fact about this computer rather than one fact about each server.
    const node = readingOf(out, {}).node
    assert.equal(node.probeTool, false)
    assert.equal(node.read, false, "a server nothing asked was marked as read")
    assert.equal(Fleet.stateLabel(node), "measuring",
      "a machine with no curl blamed the server instead")

    // The panel says the real cause, once, in the headline and the line below.
    const fleet = Fleet.fleetState([node, node])
    assert.equal(fleet.noTool, 2)
    assert.equal(fleet.down, 0, "servers nobody asked were counted as down")
    assert.equal(Fleet.headline(fleet, true, Fleet.baselineReady([node, node])),
      "curl is not installed", "the headline blamed the servers for a missing package")
    assert.equal(runPanelDetail({ nodes: [node, node] }),
      "Every server is probed with curl — install it to use this widget")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a failure reason is only read when nothing else parsed", () => {
  // The markers are ours, but a server could put those words in a body. They
  // are consulted only once parse() has found no reading at all, so the worst a
  // forged one achieves is a differently-worded FAILURE -- never a claim that
  // something is healthy, and never a state better than the truth.
  const forged = "PORT 8000\nRT vllm\nvllm:generation_tokens_total 5\nNOANSWER\n"
  const res = readingOf(forged, { sample: { work: 1, at: 0 } })
  assert.equal(res.node.reachable, true, "a forged marker buried a real reading")
  assert.equal(res.node.notResponding, false)
  assert.equal(res.state.sample.work, 5)

  assert.equal(Probe.failure(""), null)
  assert.equal(Probe.failure("nothing recognisable"), null)
  assert.equal(Probe.failure("NOANSWER"), "noanswer")
  assert.equal(Probe.failure("NOTOOL"), "notool")
})
