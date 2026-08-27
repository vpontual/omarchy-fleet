.pragma library

// Everything the widget renders passes through here first.
//
// Model names, nicknames and error messages all reach a label in the shared
// desktop bar, and all three come from somewhere this plugin does not control:
// a server's own response, or something the user typed. So each is stripped of
// anything that could break out of its row and clamped to a length that cannot
// reflow the panel.

var MAX_LABEL = 32

// How long a rendered string may be before it is cut. Everything here reaches
// the bar's popup, and the bar belongs to the whole desktop -- a config error
// listing thirty rejected entries should shorten, not reflow the panel.
var MAX_MESSAGE = 160

function clampField(value) {
  var text = stripControl(String(value || "")).trim()
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 1) + "\u2026" : text
}

// Shared by clampField and stripLabel so there is one definition of "what may
// not appear in anything we render".
function stripControl(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\u0080-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/g, "")
}

// A nickname is typed by the user, not served by a node, but it is still
// rendered -- so it is stripped of anything that could break out of its row
// and clamped. Same reasoning as any other string this plugin displays.
// Strip and clamp a longer field than a nickname -- an error message naming
// several rejected addresses, for instance.
//
// This existed only as a CALL until now: Service.qml invoked clampField
// and nothing defined it, carried over from a sibling plugin from
// memory. The binding that used it threw, QML left the property empty, and the
// bad-address message it was written to produce never appeared -- the exact
// silent-drop the feature was meant to end.
function stripLabel(value) {
  var text = stripControl(value).trim()
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + "\u2026" : text
}

function shortModelName(name) {
  var text = String(name || "")
  var slash = text.lastIndexOf("/")
  return slash === -1 ? text : text.slice(slash + 1)
}
