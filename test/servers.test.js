// The `servers` setting, and the boundary it defends.
//
// Its output is interpolated into a shell command, so isSafeHost is the line
// anything hostile has to cross. A rejected entry must be REPORTED rather than
// dropped: a typo used to shorten the fleet with nothing to say why.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { Servers } = require("./harness.js")
const { runConfiguredRejects, runConfiguredServers } = require("./qml.js")

test("isSafeHost accepts hosts and host:port, rejects anything shell-relevant", () => {
  assert.ok(Servers.isSafeHost("192.0.2.246"))
  assert.ok(Servers.isSafeHost("192.0.2.246:8000"))
  assert.ok(Servers.isSafeHost("gpu-box.local"))
  for (const bad of ["a;id", "a b", "a$(id)", "a`id`", "a|b", "a&b", "-x", "", "a:99999999", "a/b", "'a'"]) {
    assert.ok(!Servers.isSafeHost(bad), `must reject ${JSON.stringify(bad)}`)
  }
})

test("a bare server list still parses exactly as before", () => {
  // Backward compatibility is the point: existing configs are bare hosts,
  // comma OR whitespace separated, and must keep working untouched.
  assert.deepEqual(Servers.parseServers("10.0.0.1, 10.0.0.2"),
    [{ host: "10.0.0.1", label: "" }, { host: "10.0.0.2", label: "" }])
  assert.deepEqual(Servers.parseServers("10.0.0.1 10.0.0.2"),
    [{ host: "10.0.0.1", label: "" }, { host: "10.0.0.2", label: "" }])
  assert.deepEqual(Servers.parseServers(""), [])
  assert.deepEqual(Servers.parseServers(null), [])
})

test("host=Nickname names a server, and the nickname may contain spaces", () => {
  // The comma is the entry separator precisely so a nickname can have spaces;
  // splitting the whole string on whitespace would cut "DGX Spark" in two.
  assert.deepEqual(
    Servers.parseServers("10.0.0.5=DGX Spark, gpu.local:8000 = My GPU Box"),
    [{ host: "10.0.0.5", label: "DGX Spark" },
     { host: "gpu.local:8000", label: "My GPU Box" }])
})

test("named and unnamed servers mix in one list", () => {
  assert.deepEqual(Servers.parseServers("10.0.0.1=Nano, 10.0.0.2, 10.0.0.3=Orin"),
    [{ host: "10.0.0.1", label: "Nano" },
     { host: "10.0.0.2", label: "" },
     { host: "10.0.0.3", label: "Orin" }])
})

test("only the first = splits, so a nickname may contain one", () => {
  assert.deepEqual(Servers.parseServers("10.0.0.1=a=b"),
    [{ host: "10.0.0.1", label: "a=b" }])
})

test("a malformed host is still rejected even when it carries a nickname", () => {
  // The nickname must not become a way to smuggle something past isSafeHost.
  for (const bad of ["1.2.3.4; rm -rf /", "$(id)", "`id`", "10.0.0.1|x"]) {
    assert.equal(Servers.isSafeHost(Servers.parseServers(bad + "=Friendly")[0].host), false,
      `${bad} passed validation when named`)
  }
  assert.equal(Servers.isSafeHost(Servers.parseServers("10.0.0.1=Friendly")[0].host), true)
})

test("splitHostPort separates an explicit port, and leaves a bare host alone", () => {
  assert.deepEqual(Servers.splitHostPort("gpu.local"), { host: "gpu.local", port: null })
  assert.deepEqual(Servers.splitHostPort("gpu.local:8000"), { host: "gpu.local", port: 8000 })
  assert.deepEqual(Servers.splitHostPort("10.0.0.5:11434"), { host: "10.0.0.5", port: 11434 })
  // Not a port -- leave the string intact rather than mangling it.
  assert.deepEqual(Servers.splitHostPort("gpu.local:abc"), { host: "gpu.local:abc", port: null })
  assert.deepEqual(Servers.splitHostPort(""), { host: "", port: null })
})

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
      assert.ok(Servers.isSafeHost(entry.host),
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

test("an address is rejected for a port no server could answer on", () => {
  // The pattern allowed five digits, which reaches 99999. Such an entry was
  // accepted, probed as a URL nothing can serve, and drawn "unreachable" --
  // instead of surfacing the config error the user needed to see.
  assert.equal(Servers.isSafeHost("192.0.2.10:8000"), true)
  assert.equal(Servers.isSafeHost("192.0.2.10:65535"), true)
  assert.equal(Servers.isSafeHost("192.0.2.10:99999"), false, "a port above 65535 was accepted")
  assert.equal(Servers.isSafeHost("192.0.2.10:0"), false, "port 0 was accepted")
  assert.equal(Servers.isSafeHost("192.0.2.10"), true, "a bare host was rejected")

  // And such an entry reaches the user as a rejection.
  const parsed = Servers.parseServers("192.0.2.10:99999")
  const rejected = parsed.filter(e => !Servers.isSafeHost(e.host))
  assert.equal(rejected.length, 1, "the bad address was not flagged")
})
