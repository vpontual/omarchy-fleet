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
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent, bar.urgent) : "transparent"

  readonly property bool configured: fleet.configuredHosts().length > 0
  readonly property bool nothingReachable: configured && fleet.fleet.up === 0

  // The headline. Deliberately says "measuring" until every node has produced
  // two readings: activity is a counter delta, so before that the widget has
  // not observed an idle fleet -- it has observed nothing at all.
  readonly property string headline: {
    if (!configured) return "No servers configured"
    if (nothingReachable) return "No servers reachable"
    if (!fleet.baselineReady) return "Measuring"
    if (fleet.busy) return fleet.fleet.active === 1 ? "1 server working" : fleet.fleet.active + " servers working"
    return "Idle"
  }

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
    function refresh(): string { fleet.refresh(); return "ok" }
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
                             root.rowContentWidth + Style.spacing.lg * 2 + Style.space(24)),
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

  // ── Column widths ───────────────────────────────────────────────────
  //
  // The three left columns are measured from the WIDEST value each will hold,
  // once, at the panel level -- so every row uses identical widths and the
  // columns line up. Concatenating the fields into one label with spaces
  // between them (the first attempt) drifts as soon as two nicknames differ
  // in length, which is exactly what it looked like.
  //
  // TextMetrics measures with the same font the rows draw with, so this holds
  // for a proportional font too, not only the monospace default.
  // What a row is allowed to claim, in order of honesty.
  function stateTextFor(node) {
    if (!node) return ""
    if (!node.reachable) return "unreachable"
    if (node.canReportActivity === false) return "no activity signal"
    if (node.firstReading) return "measuring"
    if (node.activity && node.activity.active) {
      return typeof node.activity.amount === "number" && node.activity.amount > 0
        ? "working  " + node.activity.amount + " tok"
        : "working"
    }
    return "idle"
  }

  function _widest(field) {
    var nodes = fleet.nodes || []
    var best = ""
    for (var i = 0; i < nodes.length; i++) {
      var v = ""
      if (field === "label") v = String(nodes[i].label || "")
      else if (field === "host") v = String(nodes[i].host || "")
      else if (field === "state") v = root.stateTextFor(nodes[i])
      else {
        var rt = nodes[i].runtime ? Model.runtimeOf(nodes[i].runtime) : null
        v = rt ? rt.label : String(nodes[i].runtime || "")
      }
      if (v.length > best.length) best = v
    }
    return best
  }

  // advanceWidth, ceiled, plus a pixel: TextMetrics.width is the ink extent and
  // comes out fractionally narrower than the width Text lays itself out to, so
  // binding to it directly elides every value by one character -- which looked
  // like the columns were too narrow rather than off by a rounding step.
  function _col(metrics) { return metrics.text === "" ? 0 : Math.ceil(metrics.advanceWidth) + 1 }

  // The width a row actually occupies, computed from the column widths rather
  // than read off the Row.
  //
  // Row.implicitWidth sums its children's implicitWidth -- their NATURAL text
  // widths -- not the widths assigned to them. With every server idle that
  // summed the word "idle" rather than the state column, so the panel sized
  // itself to a narrow row and then clipped "working  257 tok" the moment a
  // server started working. The visible symptom was the word it grew for being
  // the one word cut off.
  readonly property real rowContentWidth: {
    var cols = [_col(labelMetrics), _col(hostMetrics), _col(runtimeMetrics), _col(stateMetrics)]
    var total = 0, shown = 0
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] <= 0) continue
      total += cols[i]
      shown++
    }
    return total + Style.spacing.lg * Math.max(0, shown - 1)
  }

  TextMetrics {
    id: labelMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: root._widest("label")
  }
  TextMetrics {
    id: hostMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: root._widest("host")
  }
  TextMetrics {
    id: runtimeMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: root._widest("runtime")
  }
  // Sized for the widest state this column can REACH, not the widest it happens
  // to be showing. Sizing to the current values made the panel jump wider the
  // moment a server started working -- and clip the word it grew for, when the
  // new width hit the cap. A representative worst case keeps the width stable
  // and always fitting.
  TextMetrics {
    id: stateMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
    text: {
      var current = root._widest("state")
      var worst = "working  9999 tok"
      return current.length > worst.length ? current : worst
    }
  }

  component NodeRow: CursorSurface {
    id: nodeRow
    property var node: null

    readonly property string runtimeLabel: {
      if (!node || !node.runtime) return ""
      var rt = Model.runtimeOf(node.runtime)
      return rt ? rt.label : node.runtime
    }
    // One definition, used by the row AND by the column measurement above --
    // two copies would drift and the column would size to the wrong string.
    readonly property string stateText: root.stateTextFor(node)
    // A traffic light, because the state is the thing you glance at.
    //
    // Green and amber are fixed rather than theme-derived: the shell's
    // foundational palette is foreground/background/accent/urgent/muted, with
    // no semantic green, and status colour is conventional in a way accent is
    // not -- accent is blue in some themes and would read as "information".
    // Red stays root.urgent, which IS the theme's own alert colour, so the one
    // state that means "something is wrong" matches the rest of the bar.
    readonly property color stateColor: {
      if (!node || !node.reachable) return root.urgent          // down
      if (node.canReportActivity === false) return root.dim     // cannot tell, ever
      if (node.firstReading) return nodeRow.amber               // cannot tell yet
      if (node.activity && node.activity.active) return nodeRow.amber
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
      var model = Model.shortModelName(node.model || "")
      if (model !== "") bits.push(model)
      // A fraction on the wire; a percentage is what a person reads. Shown only
      // once it means something -- an idle engine sitting at 0% is noise.
      if (typeof node.cache === "number" && node.cache > 0.01)
        bits.push(Math.round(node.cache * 100) + "% cache")
      if (typeof node.waiting === "number" && node.waiting > 0)
        bits.push(node.waiting + " queued")
      return bits.join("   ")
    }

    implicitHeight: nameText.implicitHeight
                    + (detailLine.visible ? detailLine.implicitHeight + Style.spacing.xs : 0)
                    + Style.spacing.md * 2
    // Report the width the columns actually occupy, so the panel can size to
    // its content instead of to a fixed number.
    implicitWidth: root.rowContentWidth + Style.spacing.lg * 2
    foreground: root.foreground
    fill: root.hoverFill

    // Nickname, address and runtime as three real columns. The nickname is
    // kept BESIDE the address rather than replacing it: a name you chose
    // identifies the box, but the address is what you need when it stops
    // answering. With no nickname configured the column collapses to zero
    // width and the address simply starts at the left.
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
        width: root._col(labelMetrics)
        visible: width > 0
        text: nodeRow.node ? String(nodeRow.node.label || "") : ""
        color: root.foreground
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        textFormat: Text.PlainText
        width: root._col(hostMetrics)
        text: nodeRow.node ? String(nodeRow.node.host || "") : ""
        color: root.foreground
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        textFormat: Text.PlainText
        width: root._col(runtimeMetrics)
        visible: width > 0
        text: nodeRow.runtimeLabel
        color: root.dim
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        id: stateLabel
        textFormat: Text.PlainText
        width: root._col(stateMetrics)
        // Centred in the column rather than left-aligned in it. The column is
        // sized for the widest state it can reach, so a short "idle" otherwise
        // hugs the left edge with all the reserved space trailing after it.
        horizontalAlignment: Text.AlignHCenter
        text: nodeRow.stateText
        color: nodeRow.stateColor
        elide: Text.ElideRight
        font.family: root.fontFamily
        // Bigger and heavier than the address beside it: this is the one field
        // the widget exists to report, and it was the smallest thing here.
        font.pixelSize: Style.font.body
        font.bold: true
      }
    }

    Text {
      // Server-controlled: the model id is whatever the operator named it, so
      // it is stripped and clamped in Model.js and rendered as plain text.
      textFormat: Text.PlainText
      id: detailLine
      anchors.left: nameText.left
      anchors.leftMargin: root._col(labelMetrics) > 0
                          ? root._col(labelMetrics) + Style.spacing.lg : 0
      anchors.top: nameText.bottom
      anchors.topMargin: Style.spacing.xs
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      visible: text !== ""
      text: nodeRow.detailText
      color: root.dim
      elide: Text.ElideRight
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
