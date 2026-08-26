import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// How wide each column has to be, measured once for the whole table.
//
// Every row is handed identical widths so the columns line up; a row that
// measured for itself would drift the moment two nicknames differed in length.
// This lived in Panel.qml, whose job is drawing -- 88 lines of measurement in a
// file that also drew the panel, composed the headline copy and rendered rows.
//
// TextMetrics measures with the same font the rows draw with, so this holds for
// a proportional font too, not only the monospace default. The metrics are
// declared as PROPERTIES rather than children because QtObject has no default
// property and silently refuses to hold them -- "Cannot assign to non-existent
// default property", which surfaces only when a real shell loads the file.
QtObject {
  id: widths

  // The rows to size for, and the font they will be drawn in.
  property var nodes: []
  property string fontFamily: Style.font.family

  readonly property real label: _col(labelMetrics)
  readonly property real host: _col(hostMetrics)
  readonly property real runtime: _col(runtimeMetrics)
  readonly property real state: _col(stateMetrics)

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

  // The widest value a column will have to hold.
  //
  // An unknown column name returns "" rather than falling through to the
  // runtime label: a typo used to measure the wrong field silently.
  function _widest(field) {
    var rows = widths.nodes || []
    var best = ""
    for (var i = 0; i < rows.length; i++) {
      var v = ""
      if (field === "label") v = String(rows[i].label || "")
      else if (field === "host") v = String(rows[i].host || "")
      else if (field === "state") v = Model.stateLabel(rows[i])
      else if (field === "runtime") {
        var rt = rows[i].runtime ? Model.runtimeOf(rows[i].runtime) : null
        v = rt ? rt.label : String(rows[i].runtime || "")
      } else {
        return ""
      }
      if (v.length > best.length) best = v
    }
    return best
  }

  // advanceWidth, ceiled, plus a pixel: TextMetrics.width is the ink extent and
  // comes out fractionally narrower than the width Text lays itself out to, so
  // binding to it directly elides every value by one character -- which looked
  // like the columns were too narrow rather than off by a rounding step.
  function _col(metrics) {
    return metrics.text === "" ? 0 : Math.ceil(metrics.advanceWidth) + 1
  }

  readonly property TextMetrics labelMetrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
    text: widths._widest("label")
  }
  readonly property TextMetrics hostMetrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
    text: widths._widest("host")
  }
  readonly property TextMetrics runtimeMetrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
    text: widths._widest("runtime")
  }

  // Sized for the widest state this column can REACH, not the widest it happens
  // to be showing. Sizing to the current values made the panel jump wider the
  // moment a server started working -- and clip the word it grew for, when the
  // new width hit the cap. A representative worst case keeps the width stable
  // and always fitting.
  readonly property TextMetrics stateMetrics: TextMetrics {
    font.family: widths.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
    text: {
      var current = widths._widest("state")
      var worst = "working  9999 tok"
      return current.length > worst.length ? current : worst
    }
  }
}
