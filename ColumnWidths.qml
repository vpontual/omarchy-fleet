import QtQuick
import qs.Commons
import "lib/Fleet.js" as Fleet

// How wide each column has to be, measured once for the whole table.
//
// Every row is handed identical widths so the columns line up; a row that
// measured for itself would drift the moment two nicknames differed in length.
// TextMetrics uses the same font the rows draw with, so this holds for a
// proportional font too.
//
// The metrics object is a PROPERTY rather than a child: QtObject has no default
// property and silently refuses to hold one, which surfaces only when a real
// shell loads the file.
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
  // Row.implicitWidth sums its children's NATURAL text widths, not the widths
  // assigned to them -- so with every server idle it sums the word "idle", and
  // the panel then clips "working  257 tok" the moment one starts working.
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
  // Characters are not width in a proportional font: "no activity signal" is
  // 18 characters of mostly i/l/t and lays out NARROWER than the 17-character
  // "working  9999 tok". So every candidate is measured, not the longest one.
  //
  // advanceWidth, ceiled, plus a pixel: TextMetrics.width is the ink extent and
  // is fractionally narrower than the width Text lays itself out to, so using
  // it directly elides every value by one character.
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
    widths.label = _widest(Fleet.columnValues(widths.nodes, "label"))
    widths.host = _widest(Fleet.columnValues(widths.nodes, "host"))
    widths.runtime = _widest(Fleet.columnValues(widths.nodes, "runtime"))
    // Sized for the widest state this column can REACH, not the widest it
    // happens to be showing -- otherwise the panel jumps wider the moment a
    // server starts working, and clips the word it grew for.
    widths.state = _widest(
      Fleet.columnValues(widths.nodes, "state").concat(["working  9999 tok"]), true)
  }

  property TextMetrics metrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
  }
}
