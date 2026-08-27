.pragma library
.import "Fleet.js" as Fleet
.import "Runtimes.js" as Runtimes
.import "Metrics.js" as Metrics
.import "Probe.js" as Probe

// One probe result in, one node record out.
//
// Pure: plain objects in, plain objects out, no Process, no timers, no shell.
// The honesty rules about what a node may claim are the whole point of the
// file, so they are executed by tests rather than matched against QML source.
function apply(host, label, out, prev, now) {
  prev = prev || {}
  var node = Fleet.blankNode(host, label, prev)
  // A probe came back for this host. Says nothing about whether it succeeded --
  // only that the row below is a report rather than a placeholder, which is
  // the distinction every "unreachable" claim rests on.
  node.read = true
  var state = null

  var read = Probe.parse(out)
  if (read) {
    node.reachable = true
    node.runtime = read.runtime
    node.port = read.port !== null ? read.port : prev.port

    var sample = Metrics.readSample(read.runtime, read.body)

    // Answered, but published nothing readable -- an absence of evidence, which
    // must not look like "idle". Keyed off whether a sample PARSED rather than
    // off the marker, which only covers an empty body: a series that merely
    // prefix-matches the filter otherwise falls through and reads green.
    if (!sample) node.canReportActivity = false

    if (sample) {
      node.running = sample.running
      node.waiting = sample.waiting
      node.cache = sample.cache
      node.model = sample.model

      // Neither a work counter nor a keep-alive token. `work === null` alone is
      // NOT this test -- Ollama legitimately has no counter and signals through
      // `token` -- so checking only `work` condemns every healthy Ollama node.
      if (sample.work === null && !sample.token) {
        node.canReportActivity = false
      } else if (prev.sample) {
        // null means the pair could not be compared -- a restarted counter, or
        // one the exporter omitted last poll. Saying "idle" there is a claim
        // about work that was never measured; "measuring" is the truth, and
        // the next comparable pair clears it.
        var moved = Metrics.activityBetween(prev.sample, sample)
        // Can this sample support the claim "nothing is happening"? A work
        // COUNTER can: a delta of zero is a measurement. Anything else has to
        // say so outright.
        var provesQuiet = sample.work !== null || sample.quietProven === true
        if (!moved) node.firstReading = true
        else if (moved.active || provesQuiet) node.activity = moved
        else {
          // A TOKEN-ONLY signal is ONE-DIRECTIONAL. Ollama pushes its
          // keep-alive expiry forward when a request COMPLETES, not while one
          // runs -- measured across a 25-second generation as eight identical
          // polls, advancing only afterwards. So "the token did not move" is
          // exactly what a GENERATING server looks like, and with
          // `keep_alive: -1` it never moves at all.
          //
          // Such a signal can support "working" and never "idle". The row
          // reads "no activity signal", which is true.
          node.canReportActivity = false
        }
      } else {
        node.firstReading = true
      }
    }

    // Cache what was DETECTED, whether or not a sample parsed. Caching only on
    // a successful sample means a node that answers with nothing usable is
    // never remembered, so the fifteen-request sweep re-runs on every poll --
    // five requests a second at the interval, against that host, forever.
    state = { host: host, port: node.port, runtime: read.runtime,
              sample: sample || null, lastSeenMs: now }
  } else {
    // Nothing parsed. WHY nothing parsed is the difference between three very
    // different situations, and they used to be one word: "unreachable".
    var failed = Probe.failure(out)
    // No curl on this machine: nothing was ASKED, so the row is un-probed
    // rather than a server that failed to answer. The panel names the cause.
    if (failed === "notool") { node.probeTool = false; node.read = false }
    else if (failed === "noanswer") node.notResponding = true

    // Keep what we learned so a blip does not force rediscovery, but do not
    // carry the old sample forward -- a stale counter would fabricate a delta
    // the moment the node returns.
    //
    // A cached runtime whose adapter no longer exists must be DROPPED:
    // Probe.script returns "" for it, which yields no output, which lands back
    // here and preserves it again -- forever, spawning a no-op shell each poll.
    if (prev.runtime && Runtimes.runtimeOf(prev.runtime)) {
      state = { host: host, port: prev.port, runtime: prev.runtime,
                sample: null, lastSeenMs: prev.lastSeenMs }
    }
  }

  return { node: node, state: state }
}
