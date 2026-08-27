.pragma library
.import "Fleet.js" as Fleet

// The three pure decisions behind Service.qml's polling loop.
//
// They live here, executed by tests, because the fleet-wide version of the
// first one -- the fence deciding whether a host may be polled -- was asserted
// only by matching QML source text, and the defect it was written to prevent
// had inverted underneath the assertion without ever breaking it.

// What this tick should do with one host's probe slot.
//
// `skip` while a probe is still inside the deadline its own script was given
// is the entire fix for the fleet-wide stall: a discovery sweep may take 33
// seconds, and the hosts beside it must keep polling at the configured
// interval regardless. `kill` only ever fires for a process that ignored the
// `timeout --signal=KILL` wrapped around it.
function pollAction(slot, now) {
  if (!slot) return "start"
  // A killed probe has not necessarily died yet, and its exit is not evidence
  // about anything. The slot stays out of service until it lands.
  if (slot.abandoned) return "skip"
  if (!slot.running) return "start"
  if (now < slot.deadlineMs) return "skip"
  return "kill"
}

// The table, assembled from whatever each host has last said.
//
// A host nothing has come back from yet still gets a row -- the table shows
// what you configured from the moment you configure it -- and that row is a
// blank one, which reads "measuring". Order is by address so a row does not
// move under the cursor when one host answers before another.
function tableRows(servers, rows, state) {
  var list = servers || [], have = rows || {}, cached = state || {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var host = list[i].host
    out.push(have[host] || Fleet.blankNode(host, list[i].label, cached[host]))
  }
  out.sort(function (a, b) { return a.host < b.host ? -1 : 1 })
  return out
}

// Drop every key that is not a configured host.
//
// Bounded by the config, so never large -- but a host removed from the
// settings kept its cached port, runtime and last sample indefinitely, and got
// them back if it was ever re-added, sample included.
function pruneToConfigured(map, hosts) {
  var live = {}, out = {}
  for (var i = 0; i < (hosts || []).length; i++) live[hosts[i]] = true
  for (var key in (map || {})) { if (live[key]) out[key] = map[key] }
  return out
}
