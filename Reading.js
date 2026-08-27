// One probe result in, one node record out.
//
// This lived inside Service.qml's _finish, where every branch below could only
// be reached by a test through a source-text extractor -- and an assertion that
// reads source can pass against a comment. It is pure: plain objects in, plain
// objects out, no Process, no timers, no shell. The honesty rules about what a
// node may claim are the whole point of the file, so they are executed.
function apply(Model, Probe, host, label, out, prev, now) {
  prev = prev || {}
  var node = Model.blankNode(host, label, prev)
  var state = null

  var read = Probe.parse(Model, out, Model.MAX_PROBE_BYTES)
  if (read) {
    node.reachable = true
    node.runtime = read.runtime
    node.port = read.port !== null ? read.port : prev.port

    var rt = Model.runtimeOf(read.runtime)
    node.canReportActivity = !(rt && rt.noActivity)

    var sample = Model.readSample(read.runtime, read.body)

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
        var moved = Model.activityBetween(prev.sample, sample)
        if (moved) node.activity = moved
        else node.firstReading = true
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
  } else if (prev.runtime) {
    // Keep what we learned so a blip does not force rediscovery, but do not
    // carry the old sample forward -- a stale counter would fabricate a delta
    // the moment the node returns.
    state = { host: host, port: prev.port, runtime: prev.runtime,
              sample: null, lastSeenMs: prev.lastSeenMs }
  }

  return { node: node, state: state }
}
