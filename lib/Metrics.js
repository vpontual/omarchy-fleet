.pragma library
.import "Runtimes.js" as Runtimes
.import "Text.js" as Text

// Prometheus parsing, and the one number this widget is actually about.
//
// The signal must be a COUNTER, not a gauge. A gauge like
// vllm:num_requests_running only shows work in flight at the instant we
// sample, so a request that starts and finishes between two polls is
// invisible. A monotonic token counter still moves, so the light catches it.
// Verified against a live server: one 2-token completion moved
// vllm:generation_tokens_total from 48456 to 48458.
//
// Counters SUM across engines and models; fractions must be AVERAGED. Getting
// that backwards reported two engines at 50% as "100% cache".

// The model a metrics-bearing runtime is serving, read from labels already
// present on the series being fetched. Free: no extra request, no extra
// endpoint.
//
// The string is chosen by whoever runs the server, so it is treated like any
// other remote value: tail first, then stripped and clamped, before it can
// reach a label in the shared bar.
function modelFromMetrics(body) {
  var match = String(body || "").match(/model_name="([^"]*)"/)
  if (!match) return ""
  // Tail FIRST, then clamp. Clamping first let the vendor segment eat the
  // budget and cut the part this is supposed to keep:
  // "meta-llama/Meta-Llama-3.1-70B-Instruct" became "Meta-Llama-3.1-70B-I...",
  // and a 40-character vendor degenerated to an ellipsis alone.
  return Text.stripLabel(Text.shortModelName(match[1]))
}

// Sums every series sharing a metric name. vLLM emits one series per engine
// and per model, so a multi-model node would otherwise report only whichever
// line happened to be last.
function sumMetric(text, metric) {
  var lines = String(text || "").split("\n")
  var total = null
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.charAt(0) === "#") continue
    if (line.indexOf(metric) !== 0) continue
    // Either "name value" or "name{labels} value".
    var rest = line.slice(metric.length)
    if (rest.charAt(0) === "{") {
      var close = rest.indexOf("}")
      if (close === -1) continue
      rest = rest.slice(close + 1)
    } else if (rest.charAt(0) !== " ") {
      // A longer metric name that merely starts with this one.
      continue
    }
    var value = parseFloat(rest.trim().split(/\s+/)[0])
    if (isFinite(value)) total = (total === null ? 0 : total) + value
  }
  return total
}

// The MEAN of a series, for gauges rather than counters.
//
// sumMetric exists because vLLM emits one series per engine and per model, and
// summing is right for counts: two engines each running one request really are
// two requests. It is wrong for a FRACTION. Two engines each 50% full summed to
// 1, which the panel rendered as "100% cache" -- the Fleet.headline "is it
// struggling" number, maximally wrong on exactly the multi-engine node
// sumMetric was written for.
function avgMetric(text, metric) {
  var values = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.charAt(0) === "#") continue
    if (line.indexOf(metric) !== 0) continue
    var rest = line.slice(metric.length)
    if (rest.charAt(0) !== "{" && rest.charAt(0) !== " ") continue
    // The FIRST field after the labels, not the last. The Prometheus text
    // format allows an optional timestamp after the value, and reading the last
    // field turned "0.5 1700000000000" into 1.7e12 -- rendered as
    // "170000000000000% cache". sumMetric, this function's near-twin, always
    // read the first; the two had drifted in the one line where they differ.
    var value = parseFloat(rest.replace(/^\{[^}]*\}/, "").trim().split(/\s+/)[0])
    if (isFinite(value)) values.push(value)
  }
  if (values.length === 0) return null
  var total = 0
  for (var v = 0; v < values.length; v++) total += values[v]
  return total / values.length
}

// One reading from one node. `work` is a monotonic counter where the runtime
// has one, or a token derived from Ollama's keep-alive expiry where it does
// not. `null` means "this runtime cannot tell us", which is different from 0.
function readSample(runtimeName, body) {
  var rt = Runtimes.runtimeOf(runtimeName)
  if (!rt) return null

  if (runtimeName === "ollama") {
    var models = []
    try {
      var parsed = JSON.parse(String(body || "{}"))
      var list = parsed.models || []
      for (var i = 0; i < list.length; i++) {
        models.push({ name: String(list[i].name || ""), expires: String(list[i].expires_at || "") })
      }
    } catch (e) {
      return null
    }
    models.sort(function (a, b) { return a.name < b.name ? -1 : 1 })
    // No model resident is a real, comparable answer: nothing is loaded, so
    // nothing can be generating. An empty string here was falsy, so the caller
    // read a healthy Ollama with an unloaded model as "no activity signal" --
    // an absence of evidence, where the evidence was actually conclusive. The
    // sentinel cannot collide with a real token, which always ends in ";".
    var token = models.length ? "" : "none"
    for (var m = 0; m < models.length; m++) token += models[m].name + "@" + models[m].expires + ";"
    return { work: null, token: token, models: models,
             // Nothing resident is the ONE thing this endpoint says conclusively:
             // a model that is not loaded cannot be generating. Every other
             // reading it gives is one-directional -- see the caller.
             quietProven: models.length === 0,
             running: null, waiting: null,
             // Tail FIRST, then clamp -- the same ordering the metrics path
             // uses. Clamping first let a long prefix eat the budget, and
             // "hf.co/unsloth/Qwen3-Coder-30B-..." is an ordinary Ollama name.
             cache: null, model: models.length ? Text.stripLabel(Text.shortModelName(models[0].name)) : "" }
  }

  // A runtime with no work counter -- `openai` has none -- must not reach
  // sumMetric, which coerces a null metric name to the string "null" and then
  // dereferences the null itself. That threw inside _finish BEFORE _pending
  // was decremented, so `probing` stayed true and every later refresh returned
  // early: the widget froze on stale data, permanently, from one response body
  // containing a line that begins with "null".
  if (!rt.work) return null
  var work = sumMetric(body, rt.work)
  // No work counter in this body -- a partial or version-skewed exporter. Say
  // so, and keep whatever it DID publish rather than discarding it: a node
  // running 8 requests at 97% cache was drawn as quiet because the one series
  // used for the delta was missing.
  if (work === null) {
    var partial = {
      work: null, token: null,
      running: sumMetric(body, rt.running),
      waiting: rt.waiting ? sumMetric(body, rt.waiting) : null,
      cache: rt.cache ? avgMetric(body, rt.cache) : null,
      model: modelFromMetrics(body)
    }
    var anything = partial.running !== null || partial.waiting !== null ||
                   partial.cache !== null || partial.model !== ""
    return anything ? partial : null
  }
  return {
    work: work,
    token: null,
    running: sumMetric(body, rt.running),
    waiting: rt.waiting ? sumMetric(body, rt.waiting) : null,
    // A fraction on the wire; a percentage is what a person reads.
    // AVERAGED, not summed: this is a fraction per engine, not a count.
    cache: rt.cache ? avgMetric(body, rt.cache) : null,
    model: modelFromMetrics(body)
  }
}

// Did any model that was resident BEFORE have its keep-alive pushed further out?
//
// The whole model list used to be joined into one string and compared for
// inequality, which read every CHANGE as work -- including the most conclusive
// evidence available that no work happened, a model evicted for inactivity.
// That drew a bold "1 server working" and lit the bar icon, on every Ollama
// node, on every idle timeout.
//
// A model that was not there before is not evidence either: it was loaded, not
// necessarily used. Only a model present in both samples whose expiry moved
// forward says anything about work.
//
// Compared as parsed times, not as strings: Ollama's fractional-second field
// varies in length, so "…07.9Z" sorts BEFORE "…07.790456934Z" lexicographically
// and is nearly a second later. An unorderable pair claims nothing, which is
// the safe direction -- it can only ever withhold a "working", never invent one.
function _expiryAdvanced(before, after) {
  var was = {}, prevList = before || [], nowList = after || []
  for (var i = 0; i < prevList.length; i++) was[prevList[i].name] = Date.parse(prevList[i].expires)
  for (var j = 0; j < nowList.length; j++) {
    var then = was[nowList[j].name]
    if (then === undefined || isNaN(then)) continue
    var now = Date.parse(nowList[j].expires)
    if (!isNaN(now) && now > then) return true
  }
  return false
}

// Did this node do work between two samples?
//
// Returns { active, amount } -- amount being tokens generated where the
// runtime counts them and null where it can only say yes/no -- or NULL for
// "these two samples cannot be compared", which is not the same answer and
// must not share a shape with one.
//
// It used to return { active: false, amount: null } for both, and Fleet.stateLabel
// renders that as "idle". So a vLLM engine restart, which resets the counter
// and yields a negative delta, drew a bold green "idle" over its own
// `4 running  2 queued  90% cache` -- while it was serving four requests. A
// counter that reappears after a poll where the exporter omitted it did the
// same, hiding every token generated in between. Both are the one case this
// function genuinely cannot answer, and the caller turns null into
// "measuring", which clears itself on the next comparable pair.
function activityBetween(prev, curr) {
  if (!prev || !curr) return null

  if (curr.work !== null && prev.work !== null) {
    var delta = curr.work - prev.work
    // Backwards means the server restarted and reset it. Not negative work,
    // and not evidence of no work either.
    if (delta < 0) return null
    return { active: delta > 0, amount: delta }
  }

  if (curr.token !== null && prev.token !== null) {
    return { active: _expiryAdvanced(prev.models, curr.models), amount: null }
  }

  return null
}
