import QtQuick
import qs.Commons
import qs.Ui
import "lib/Fleet.js" as Fleet
import "lib/Runtimes.js" as Runtimes
import "lib/Text.js" as Text

// One server's row: nickname, address, runtime, state, and a quieter line
// saying what it is running.
//
// Everything it needs is a property rather than a reach up into a parent by
// id, which is what lets it be a file of its own.
CursorSurface {
  id: nodeRow

  // Measured once by the panel and passed down, so every row is identical and
  // the columns line up. A row must not measure for itself.
  property real labelWidth: 0
  property real hostWidth: 0
  property real runtimeWidth: 0
  property real stateWidth: 0
  property real rowContentWidth: 0

  // Theme, from the bar rather than re-derived here. `foreground` comes from
  // CursorSurface and must NOT be redeclared: `foreground: root.foreground`
  // without the prefix binds the property to itself, which is a binding loop
  // masked by Panel.qml overriding it at the instantiation site.
  property color dim: Color.muted
  property color urgent: Color.urgent
  property color hoverFill: "transparent"
  property string fontFamily: Style.font.family
  property var node: null

  readonly property string runtimeLabel: {
    if (!node || !node.runtime) return ""
    var rt = Runtimes.runtimeOf(node.runtime)
    return rt ? rt.label : node.runtime
  }
  // One definition, used by the row AND by the column measurement above --
  // two copies would drift and the column would size to the wrong string.
  readonly property string stateText: Fleet.stateLabel(node)
  // A traffic light, because the state is the thing you glance at.
  //
  // Green and amber are fixed rather than theme-derived: the shell's palette
  // has no semantic green, and accent is blue in some themes and would read as
  // "information". Red stays `urgent`, the theme's own alert colour, so the one
  // state meaning "something is wrong" matches the rest of the bar.
  //
  // The ladder itself is in lib/Fleet.js, where a test can execute it.
  readonly property color stateColor: {
    var tone = Fleet.stateTone(node)
    if (tone === "down") return urgent
    if (tone === "unknown") return dim
    if (tone === "working") return nodeRow.amber
    return nodeRow.green
  }
  readonly property color green: "#7fb069"
  readonly property color amber: "#d8a657"

  // What the node is RUNNING, and whether it is under pressure. Kept on its
  // own quieter line rather than as more columns: the four above are what you
  // scan, this is what you read once something catches your eye.
  readonly property string detailText: {
    if (!node || !node.reachable) return ""
    var bits = []
    var model = Text.shortModelName(node.model || "")
    if (model !== "") bits.push(model)
    // Collected, summed across engines, carried in the row signature -- and
    // never once rendered, while the README advertised it. A row that changed
    // only in `running` therefore rebuilt itself for a number nothing drew.
    if (typeof node.running === "number" && node.running > 0)
      bits.push(node.running + " running")
    if (typeof node.waiting === "number" && node.waiting > 0)
      bits.push(node.waiting + " queued")
    // A fraction on the wire; a percentage is what a person reads. Shown only
    // once it means something -- an idle engine sitting at 0% is noise.
    if (typeof node.cache === "number" && node.cache > 0.01)
      bits.push(Math.round(node.cache * 100) + "% cache")
    return bits.join("   ")
  }

  implicitHeight: nameText.implicitHeight
                  + (detailLine.visible ? detailLine.implicitHeight + Style.spacing.xs : 0)
                  + Style.spacing.md * 2
  // Report the width the columns actually occupy, so the panel can size to
  // its content instead of to a fixed number.
  implicitWidth: rowContentWidth + Style.spacing.lg * 2
  fill: hoverFill

  // Nickname, address and runtime as three real columns. The nickname sits
  // BESIDE the address rather than replacing it: a name you chose identifies
  // the box, but the address is what you need when it stops answering. With no
  // nickname the column collapses to zero width.
  Row {
    id: nameText
    anchors.left: parent.left
    anchors.leftMargin: Style.spacing.lg
    anchors.top: parent.top
    anchors.topMargin: Style.spacing.md
    // Packed, not spread. The state used to be anchored to the right edge,
    // which left a corridor of empty space between the runtime and the one
    // field worth reading.
    spacing: Style.spacing.lg

    Text {
      // Tenant-controlled: a server's own strings can reach this label, and
      // Qt's default AutoText renders markup and will fetch remote resources.
      textFormat: Text.PlainText
      width: labelWidth
      visible: width > 0
      text: nodeRow.node ? String(nodeRow.node.label || "") : ""
      color: foreground
      elide: Text.ElideRight
      font.family: fontFamily
      font.pixelSize: Style.font.body
    }
    Text {
      textFormat: Text.PlainText
      width: hostWidth
      text: nodeRow.node ? String(nodeRow.node.host || "") : ""
      color: foreground
      elide: Text.ElideRight
      font.family: fontFamily
      font.pixelSize: Style.font.body
    }
    Text {
      textFormat: Text.PlainText
      width: runtimeWidth
      visible: width > 0
      text: nodeRow.runtimeLabel
      color: dim
      elide: Text.ElideRight
      font.family: fontFamily
      font.pixelSize: Style.font.body
    }
    Text {
      id: stateLabel
      textFormat: Text.PlainText
      width: stateWidth
      // Centred in the column rather than left-aligned in it. The column is
      // sized for the widest state it can reach, so a short "idle" otherwise
      // hugs the left edge with all the reserved space trailing after it.
      horizontalAlignment: Text.AlignHCenter
      text: nodeRow.stateText
      color: nodeRow.stateColor
      elide: Text.ElideRight
      font.family: fontFamily
      // Bigger and heavier than the address beside it: this is the one field
      // the widget exists to report, and it was the smallest thing here.
      font.pixelSize: Style.font.body
      font.bold: true
    }
  }

  Text {
    // Server-controlled: the model id is whatever the operator named it, so
    // it is stripped and clamped in lib/Text.js and rendered as plain text.
    textFormat: Text.PlainText
    id: detailLine
    anchors.left: nameText.left
    anchors.leftMargin: labelWidth > 0
                        ? labelWidth + Style.spacing.lg : 0
    anchors.top: nameText.bottom
    anchors.topMargin: Style.spacing.xs
    anchors.right: parent.right
    anchors.rightMargin: Style.spacing.lg
    visible: text !== ""
    text: nodeRow.detailText
    color: dim
    elide: Text.ElideRight
    font.family: fontFamily
    font.pixelSize: Style.font.caption
  }
}
