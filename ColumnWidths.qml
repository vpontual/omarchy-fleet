import QtQuick
import qs.Commons
import "Model.js" as Model

// How wide each column has to be, measured once for the whole table.
//
// Every row is handed identical widths so the columns line up; a row that
// measured for itself would drift the moment two nicknames differed in length.
// This lived in Panel.qml, whose job is drawing -- 88 lines of measurement in a
// file that also drew the panel, composed the headline copy and rendered rows.
//
// TextMetrics measures with the same font the rows draw with, so this holds for
// a proportional font too, not only the monospace default. The metrics object is
// declared as a PROPERTY rather than a child because QtObject has no default
// property and silently refuses to hold one -- "Cannot assign to non-existent
// default property", which surfaces only when a real shell loads the file.
QtObject {
  id: widths

  // The rows to size for, and the font they will be drawn in.
  property var nodes: []
  property string fontFamily: Style.font.family

  // Written by _measure, not bound: every value in a column is measured, and
  // measuring means assigning to the metrics object, which a binding cannot do
  // without depending on what it just wrote.
  property real label: 0
  property real host: 0
  property real runtime: 0
  property real state: 0

  onNodesChanged: _measure()
  onFontFamilyChanged: _measure()
  Component.onCompleted: _measure()

  // The width a row actually occupies, computed from the column widths rather
  // than read off the Row.
  //
  // Row.implicitWidth sums its children's implicitWidth -- their NATURAL text
  // widths -- not the widths assigned to them. With every server idle that
  // summed the word "idle" rather than the state column, so the panel sized
  // itself to a narrow row and then clipped "working  257 tok" the moment a
  // server started working: the visible symptom was the word it grew for being
  // the one word cut off.
  readonly property real rowContentWidth: {
    var cols = [label, host, runtime, state]
    var total = 0, shown = 0
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] <= 0) continue
      total += cols[i]
      shown++
    }
    return total + Style.spacing.lg * Math.max(0, shown - 1)
  }

  // The widest of them, BY MEASUREMENT.
  //
  // This used to pick the longest string by character count and measure only
  // that one. Characters are not width in a proportional font: "no activity
  // signal" is 18 characters of mostly i/l/t and lays out narrower than the
  // 17-character "working  9999 tok", so the column was sized to the wrong
  // value and clipped the other -- the same class of defect as sizing to the
  // current values instead of the reachable ones, below.
  //
  // advanceWidth, ceiled, plus a pixel: TextMetrics.width is the ink extent and
  // comes out fractionally narrower than the width Text lays itself out to, so
  // using it directly elides every value by one character -- which looked like
  // the columns were too narrow rather than off by a rounding step.
  function _widest(values, bold) {
    metrics.font.bold = bold === true
    var best = 0
    for (var i = 0; i < values.length; i++) {
      if (values[i] === "") continue
      metrics.text = values[i]
      var w = Math.ceil(metrics.advanceWidth) + 1
      if (w > best) best = w
    }
    return best
  }

  function _measure() {
    widths.label = _widest(Model.columnValues(widths.nodes, "label"))
    widths.host = _widest(Model.columnValues(widths.nodes, "host"))
    widths.runtime = _widest(Model.columnValues(widths.nodes, "runtime"))
    // Sized for the widest state this column can REACH, not the widest it
    // happens to be showing. Sizing to the current values made the panel jump
    // wider the moment a server started working -- and clip the word it grew
    // for, when the new width hit the cap. A representative worst case keeps
    // the width stable and always fitting.
    widths.state = _widest(
      Model.columnValues(widths.nodes, "state").concat(["working  9999 tok"]), true)
  }

  property TextMetrics metrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
  }
}
