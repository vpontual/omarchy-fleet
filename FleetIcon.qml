import QtQuick
import qs.Commons
import qs.Ui

// A stack of servers that lights when the fleet is doing work.
//
// It was a processor die before, and it read as "some chip" -- at bar size the
// pins that were meant to say "processor" are three pixels each and just make
// the silhouette noisy. Three stacked units is the conventional glyph for
// servers, and this widget is about a FLEET, not about silicon.
//
// Lit and dark differ in MASS -- solid fill against a hollow outline -- because
// at ~22px that is what reads in peripheral vision. A brightness or opacity
// difference on the same silhouette is not legible at a glance, which is the
// whole job of an activity light.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  // The fleet is generating tokens right now.
  property bool active: false
  // Nothing to report on: no servers configured, or none reachable.
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1, root.iconSize * 0.075)
  readonly property real inset: root.iconSize * 0.12
  readonly property real span: root.iconSize - root.inset * 2
  // Three units and two gaps, so a unit is a little over a quarter of the span.
  readonly property real gap: root.span * 0.11
  readonly property real unit: (root.span - root.gap * 2) / 3

  Repeater {
    model: 3
    delegate: Rectangle {
      x: root.inset
      y: root.inset + index * (root.unit + root.gap)
      width: root.span
      height: root.unit
      radius: Math.max(1, root.unit * 0.28)
      color: root.active ? root.color : "transparent"
      border.color: root.color
      border.width: root.active ? 0 : root.stroke

      // The drive LED. Punched out of a lit unit and drawn on a dark one, so
      // it stays visible either way rather than disappearing into the fill.
      Rectangle {
        readonly property real dot: Math.max(1, root.unit * 0.3)
        width: dot; height: dot; radius: dot / 2
        x: root.unit * 0.42
        anchors.verticalCenter: parent.verticalCenter
        color: root.active ? Color.popups.background : root.color
      }
    }
  }

  Rectangle {
    visible: root.warning
    readonly property real size: Math.min(root.span * 0.5, root.iconSize * 0.28)
    width: size; height: size
    radius: size / 2
    x: root.iconSize - size
    y: root.iconSize - size
    color: root.badgeColor
    border.color: Color.popups.background
    border.width: root.active ? 1 : 0
  }
}
