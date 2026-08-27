.pragma library
.import "Fleet.js" as Fleet

// The three pure decisions behind Service.qml's polling loop.
//
// Here, and executed by tests, because the fleet-wide version of the first one
// was asserted only by matching QML source text -- and the defect it was
// written to prevent inverted underneath the assertion without breaking it.

// What this tick should do with one host's probe slot.
//
// `skip` while a probe is inside the deadline its own script was given is the
// whole fix for the fleet-wide stall: a sweep may take 33 seconds and the hosts
// beside it must keep their own cadence. `kill` fires only for a process that
// ignored the `timeout --signal=KILL` wrapped around it.
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
// A host nothing has come back from still gets a row -- blank, which reads
// "measuring" -- so the table shows what you configured from the moment you
// configure it. Ordered by address, so a row does not move under the cursor
// when one host answers before another.
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
// Without it a host removed from the settings keeps its cached port, runtime
// and last sample indefinitely, and gets them back if it is ever re-added.
function pruneToConfigured(map, hosts) {
  var live = {}, out = {}
  for (var i = 0; i < (hosts || []).length; i++) live[hosts[i]] = true
  for (var key in (map || {})) { if (live[key]) out[key] = map[key] }
  return out
}
