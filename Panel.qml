import QtQuick
import QtQuick.Controls
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget and popup for the LLM fleet activity light.
//
// Built from the shell's own primitives so it inherits Quattro's popover
// surface, spacing and focus behaviour and tracks every theme without
// hand-rolled styling.
Panel {
  id: root

  moduleName: "veepee.fleet"
  ipcTarget: "veepee.fleet"
  manageIpc: false

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onVisibleChanged: if (!visible) close()

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  // Measured once for the whole table; every row is handed the same widths.
  ColumnWidths {
    id: widths
    nodes: fleet.nodes
    fontFamily: root.fontFamily
  }

  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent, bar.urgent) : "transparent"

  readonly property bool configured: fleet.configuredHosts().length > 0
  readonly property bool nothingReachable: configured && fleet.fleet.up === 0

  // Deliberately says "Measuring" until every node has produced two readings:
  // activity is a counter delta, so before that the widget has not observed an
  // idle fleet, it has observed nothing at all. One definition, in Model.js,
  // for the same reason stateLabel lives there.
  readonly property string headline:
    Model.headline(fleet.fleet, configured, fleet.baselineReady)

  readonly property string detail: {
    // A rejected address comes FIRST: a typo used to drop the server silently,
    // reported only through the diagnostics IPC verb, so the panel showed a
    // shorter fleet than the user configured with nothing to explain it.
    if (fleet.configError !== "") return fleet.configError
    if (!configured) return "Add server addresses in the widget settings"
    if (nothingReachable) return "Checked " + fleet.fleet.total + " address" + (fleet.fleet.total === 1 ? "" : "es")
    if (!fleet.baselineReady) return "Establishing a baseline to compare against"
    if (fleet.fleet.unknown > 0)
      return fleet.fleet.unknown + " server" + (fleet.fleet.unknown === 1 ? "" : "s")
             + " cannot report activity"
    return ""
  }

  onOpenedChanged: if (opened) fleet.refresh()

  Service {
    id: fleet
    settings: root.settings
    bar: root.bar
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    // The base Panel publishes these alongside open/close/toggle, and every
    // shipped plugin has them; replacing the handler quietly dropped both.
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function refresh(): string { fleet.refresh(); return "ok" }
    // Forgets what was detected first -- the escape hatch for a node found
    // before its metrics endpoint was enabled.
    function rediscover(): string { fleet.rediscover(); return "ok" }
    function busy(): string { return fleet.busy ? "busy" : "idle" }
    function diagnostics(): string { return fleet.diagnosticsJson() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        FleetIcon {
          anchors.centerIn: parent
          iconSize: Style.space(11)
          color: fleet.busy ? root.barForeground : Qt.darker(root.barForeground, 1.55)
          badgeColor: root.urgent
          active: fleet.busy
          warning: !root.configured || root.nothingReachable
        }
      }
    }
    onPressed: function (buttonCode) {
      if (buttonCode === Qt.MiddleButton) fleet.refresh()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // fittedContentWidth(desired, cap) -- the first argument is what the content
    // WANTS, not a fixed size. Passing a flat 400 made the panel 400 wide
    // whatever was in it, which is where the dead space to the right of the
    // status came from. The floor keeps the header from collapsing when there
    // are no servers configured yet.
    // Driven by the measured columns, NOT by column.implicitWidth.
    //
    // A Column whose children all bind `width: parent.width` reports an
    // implicitWidth of 0 -- Qt breaks the circular dependency that way -- so
    // sizing the panel from it silently pinned the width to the floor below,
    // and the state column then clipped the word it had grown for. Measured:
    // colImplicit=0 while the row genuinely needed far more. rowContentWidth
    // comes from TextMetrics instead, which depends on no layout at all.
    contentWidth: panel.fittedContentWidth(
                    Math.max(Style.space(300),
                             widths.rowContentWidth + Style.spacing.lg * 2 + Style.space(24)),
                    Style.space(680))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (t) { if (String(t || "").toLowerCase() === "r") fleet.refresh() }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "LLM Fleet"
            meta: root.headline
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: fleet.busy ? 1.0 : 0.5
            iconComponent: Component {
              FleetIcon {
                iconSize: Style.font.display
                color: fleet.busy ? root.foreground : root.dim
                badgeColor: root.urgent
                active: fleet.busy
                warning: !root.configured || root.nothingReachable
              }
            }
            trailingControl: Component {
              Button {
                iconText: "\u{f0450}"
                tooltipText: "Refresh"
                foreground: root.foreground
                fontFamily: root.fontFamily
                iconSize: Style.font.icon
                horizontalPadding: Style.space(5)
                verticalPadding: Style.space(2)
                iconSpinning: fleet.probing
                onClicked: fleet.refresh()
              }
            }
          }

          Text {
            // Tenant-controlled: a server's own strings can reach this label, and
            // Qt's default AutoText renders markup and will fetch remote resources.
            textFormat: Text.PlainText
            width: parent.width
            visible: text !== ""
            text: root.detail
            color: root.dim
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          PanelSeparator { width: parent.width; foreground: root.foreground }

          Repeater {
            model: fleet.nodes
            delegate: NodeRow {
              required property var modelData
              width: column.width
              node: modelData
              // Measured once, above, and handed down -- a row that measured
              // for itself would not line up with its neighbours.
              labelWidth: widths.label
              hostWidth: widths.host
              runtimeWidth: widths.runtime
              stateWidth: widths.state
              rowContentWidth: widths.rowContentWidth
              foreground: root.foreground
              dim: root.dim
              urgent: root.urgent
              hoverFill: root.hoverFill
              fontFamily: root.fontFamily
            }
          }

          Text {
            // Tenant-controlled: a server's own strings can reach this label, and
            // Qt's default AutoText renders markup and will fetch remote resources.
            textFormat: Text.PlainText
            width: parent.width
            visible: !root.configured
            text: "omarchy bar set veepee.fleet servers \"10.0.0.5, gpu.local:8000\""
            color: root.dim
            wrapMode: Text.WrapAnywhere
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }




}
