// The polling loop's decisions.
//
// The fleet-wide version of the fence below published nothing until every
// probe had returned, so the slowest host set the period for all of them and
// the configured interval was silently unachievable. It was asserted only by
// matching QML source text, and had inverted underneath the assertion.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const { Poll, codeOf, codeLines } = require("./harness.js")
const { SERVICE, extractFunction } = require("./qml.js")

test("a killed probe's output is never mistaken for a reading", () => {
  // The fleet-wide form of this fence: a straggler the watchdog had given up
  // on decremented the NEW cycle's counter, publishing a partial table and
  // then driving that counter negative. There are no cycles now -- one slot
  // per host -- so the only ambiguity left is a probe that was killed and has
  // not died yet. Its slot stays out of service until its exit lands.
  assert.equal(Poll.pollAction({ running: false, abandoned: true, deadlineMs: 0 }, 1),
    "skip", "a killed probe's slot was reused before its exit landed")
  assert.equal(Poll.pollAction({ running: false, abandoned: false, deadlineMs: 0 }, 1),
    "start")
  assert.equal(Poll.pollAction(null, 1), "start", "a host with no slot is never accounted for")

  // And whatever it eventually prints must be dropped, not recorded.
  const exit = SERVICE.slice(SERVICE.indexOf("onExited"))
  assert.ok(/if \(abandoned\)/.test(exit.slice(0, 240)),
    "an abandoned probe's output is recorded as though it were a reading")
  assert.ok(!/_pending/.test(SERVICE), "the fleet-wide outstanding-probe counter is back")
})

test("an empty configuration does not churn every tick", () => {
  // `nodes = []` on every 3s tick re-evaluated fleet and all four TextMetrics
  // for a widget with nothing to show.
  const refresh = extractFunction("refresh")
  assert.ok(/if \(nodes\.length > 0\) \{ nodes = \[\]/.test(refresh),
    "an empty config still reassigns nodes unconditionally")
})

test("a slow host cannot stall the hosts beside it", () => {
  // Nothing was published until EVERY host had finished, and no new poll could
  // begin while any of it was in flight -- so the slowest host set the period
  // for all of them and the configured interval was silently unachievable.
  // Measured at a ~16 second cycle against a configured 3, caused by one
  // unreachable address; a full discovery sweep makes it 33. Activity here is
  // a counter delta, so that interval is also the window the delta covers.
  const sweeping = { running: true, abandoned: false, deadlineMs: 33000 }
  const ready = { running: false, abandoned: false, deadlineMs: 0 }
  assert.equal(Poll.pollAction(sweeping, 5000), "skip", "a sweep was cut short")
  assert.equal(Poll.pollAction(ready, 5000), "start",
    "a host ready to be polled waits on an unrelated slow host")

  // A result is recorded against its own host and published immediately,
  // rather than joining a batch that waits for the rest of the fleet.
  assert.ok(/_rows\[host\] = res\.node/.test(SERVICE),
    "results are batched rather than recorded per host")
  const record = codeLines(extractFunction("_record"))
  assert.ok(/_publish\(\)/.test(record), "recording a result does not publish it")
  assert.ok(!/_collected/.test(SERVICE), "the fleet-wide batch is back")
})

test("the poll interval is the one the user configured", () => {
  // It was advertised as 1-60s and was not achievable: the fleet-wide fence
  // returned early while ANY host was in flight, so the effective period was
  // the slowest host's rather than the setting's.
  const svc = codeOf("Service.qml")
  assert.ok(/interval: root\.refreshIntervalSec \* 1000/.test(svc),
    "the timer does not use the configured interval")
  assert.ok(/intSetting\("refreshIntervalSec", 3, 1, 60\)/.test(svc),
    "the interval is not clamped to the range the manifest advertises")
  const refresh = codeLines(extractFunction("refresh"))
  assert.ok(!/if \(probing\) return/.test(refresh),
    "a fleet-wide fence makes the configured interval unachievable again")

  // The manifest must advertise the range the code actually clamps to, or the
  // settings panel offers a value the widget silently overrides.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  const spec = manifest.barWidget.schema.find(f => f.key === "refreshIntervalSec")
  assert.ok(spec, "the refresh interval is not in the settings schema")
  assert.equal(spec.min, 1)
  assert.equal(spec.max, 60)
  assert.equal(spec.defaultValue, 3, "the advertised default is not the one the code falls back to")
})

test("a misdetection can be cleared without restarting the shell", () => {
  // _state is never invalidated, so llama-server started WITHOUT --metrics is
  // found on /v1/models as `openai`, cached, and reads "no activity signal"
  // forever -- restarting llama.cpp with --metrics does not help.
  const svc = codeOf("Service.qml")
  assert.ok(/function rediscover\(\)/.test(svc), "there is no way to forget a detection")
  const fn = codeLines(extractFunction("rediscover"))
  assert.ok(/_state = \(\{\}\)/.test(fn), "rediscover does not clear the cache")
  assert.ok(/refresh\(\)/.test(fn), "rediscover does not then poll")
  // And it must be reachable from outside.
  const panel = codeOf("Panel.qml")
  assert.ok(/function rediscover\(\): string/.test(panel), "rediscover is not exposed over IPC")
})

test("a server removed from the settings is forgotten", () => {
  // Its cached port, runtime and last sample lived on indefinitely, and came
  // back -- sample included -- if the host was ever re-added.
  const before = { "192.0.2.10": { port: 8000, sample: { work: 5 } },
                   "192.0.2.11": { port: 8080, sample: { work: 9 } } }
  const after = Poll.pruneToConfigured(before, ["192.0.2.10"])
  assert.deepEqual(Object.keys(after), ["192.0.2.10"])
  assert.equal(after["192.0.2.10"].sample.work, 5, "the surviving host lost its sample")

  // Including when the LAST server is removed -- that path returned early,
  // before the prune, so the final host's cache outlived the config entirely.
  assert.deepEqual(Poll.pruneToConfigured(before, []), {})
  const refresh = codeLines(extractFunction("refresh"))
  // The empty-config path returns early, BEFORE the prune below it, so the
  // last server's cached port, runtime and sample outlived the config that
  // named it. Both halves are asserted: `indexOf(...) < indexOf("return")`
  // alone passes when the line is absent entirely, which is exactly the
  // mutation it was written to catch.
  const clears = refresh.indexOf("_state = ({})")
  assert.ok(clears > -1, "the empty-config path never forgets the last server")
  assert.ok(refresh.indexOf("_rows = ({})") > -1, "it never drops the last server's row")
  assert.ok(clears < refresh.indexOf("return"), "it forgets only after returning")
  assert.ok(/_state = Poll\.pruneToConfigured/.test(SERVICE), "the service never prunes state")
  assert.ok(/_rows = Poll\.pruneToConfigured/.test(SERVICE), "removed hosts keep their rows")
})
