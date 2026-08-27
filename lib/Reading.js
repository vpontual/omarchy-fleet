.pragma library
.import "Fleet.js" as Fleet
.import "Runtimes.js" as Runtimes
.import "Metrics.js" as Metrics
.import "Probe.js" as Probe

// One probe result in, one node record out.
//
// This lived inside Service.qml's _finish, where every branch below could only
// be reached by a test through a source-text extractor -- and an assertion that
// reads source can pass against a comment. It is pure: plain objects in, plain
// objects out, no Process, no timers, no shell. The honesty rules about what a
// node may claim are the whole point of the file, so they are executed.
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

    // Answered, but published nothing readable. "idle" would be a claim about
    // work; this is an absence of evidence, and the two must not look alike.
    // Keying off the NOSAMPLE marker instead covered only an EMPTY body, so a
    // node answering with an unreadable one -- a series that merely prefix-
    // matches the filter, a cached port serving something else -- fell through
    // every branch and was drawn green "idle".
    if (!sample) node.canReportActivity = false

    if (sample) {
      node.running = sample.running
      node.waiting = sample.waiting
      node.cache = sample.cache
      node.model = sample.model

      // No activity signal AT ALL -- neither a work counter nor Ollama's
      // keep-alive token. `work === null` alone is not that test: Ollama
      // legitimately has no counter and signals through `token`, so checking
      // only `work` marked every healthy Ollama node as unable to report
      // activity. Caught by looking at a real one.
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
          // A TOKEN-ONLY signal is ONE-DIRECTIONAL and this is the whole of
          // finding it out. Ollama has no work counter; it publishes a
          // keep-alive expiry, and Ollama pushes that forward when a request
          // COMPLETES, not while one is running. Measured against a live
          // server across a 25-second generation: eight consecutive polls, all
          // identical, and it advanced only after the generation finished. So
          // "the token did not move" is not evidence of an idle server -- it
          // is exactly what a generating one looks like, and the widget drew
          // it bold green over a node that was working. With `keep_alive: -1`
          // the expiry is a constant and it would have said idle forever.
          //
          // The signal can therefore support "working" and can never support
          // "idle". Saying so reuses the mechanism openai already needs, and
          // the row reads "no activity signal" -- which is true.
          node.canReportActivity = false
        }
      } else {
        node.firstReading = true
      }
    }

    // Cache what was DETECTED, whether or not a sample parsed. Caching only on
    // a successful sample meant a node that answered but yielded nothing usable
    // was never remembered, so the full sweep -- five ports times three
    // endpoints -- re-ran on every refresh. At the default interval that is
    // five requests a second against that host, indefinitely, while the panel
    // showed it reachable and idle. A server triggers it by emitting `vllm:`
    // without a token counter, which is also what a version skew produces.
    state = { host: host, port: node.port, runtime: read.runtime,
              sample: sample || null, lastSeenMs: now }
  } else {
    // Nothing parsed. WHY nothing parsed is the difference between three very
    // different situations, and they used to be one word: "unreachable".
    var failed = Probe.failure(out)
    if (failed === "notool") node.probeTool = false
    else if (failed === "noanswer") node.notResponding = true

    // Keep what we learned so a blip does not force rediscovery, but do not
    // carry the old sample forward -- a stale counter would fabricate a delta
    // the moment the node returns.
    //
    // A cached runtime whose adapter no longer exists is NOT worth keeping:
    // Probe.script returns "" for it, which yields no output, which lands right
    // back here and preserves it again. The row reads "unreachable" forever and
    // a no-op shell is spawned every few seconds, for the life of the shell.
    if (prev.runtime && Runtimes.runtimeOf(prev.runtime)) {
      state = { host: host, port: prev.port, runtime: prev.runtime,
                sample: null, lastSeenMs: prev.lastSeenMs }
    }
  }

  return { node: node, state: state }
}
