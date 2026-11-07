// The widget in the panel: a glyph and count for each kind that has any
// (▲ needs you, ✗ broke, ✻ working, ◉ watching, ✓ done), or ○ when nothing
// runs. A ring stays while there's something you haven't opened the inbox
// for; a new ▲ or ✗ fills the chip with its colour for a moment.
import QtQuick
import "mocha.js" as M

Rectangle {
    id: chip

    property var counts: ({})
    property bool ring: false
    property bool flashing: false
    property color flashColor: M.peach
    property int fontSize: 14

    readonly property var segs: {
        const kinds = [["you", "▲", true], ["broke", "✗", true], ["work", "✻", false], ["watch", "◉", false], ["done", "✓", false]]
        const out = kinds.filter(k => (counts[k[0]] || 0) > 0).map(k => ({ t: k[1] + counts[k[0]], color: M.section[k[0]], bold: k[2] }))
        return out.length ? out : [{ t: "○", color: M.overlay0, bold: false }]
    }

    implicitWidth: row.implicitWidth + 2 * Math.round(fontSize * 0.8)
    implicitHeight: row.implicitHeight + Math.round(fontSize * 0.6)
    radius: 6
    color: flashing ? flashColor : M.base
    border.width: 2
    border.color: flashing ? flashColor : ring ? M.peach : "transparent"
    Behavior on color { ColorAnimation { duration: 160 } }

    // The ring's soft outer glow.
    Rectangle {
        z: -1
        anchors.fill: parent
        anchors.margins: -3
        radius: parent.radius + 3
        color: "transparent"
        border.width: 3
        border.color: "#38fab387"
        visible: chip.ring && !chip.flashing
    }

    Row {
        id: row
        anchors.centerIn: parent
        spacing: Math.round(chip.fontSize * 0.75)
        Repeater {
            model: chip.segs
            Text {
                required property var modelData
                text: modelData.t
                color: chip.flashing ? M.crust : modelData.color
                font.family: M.mono
                font.pixelSize: chip.fontSize
                font.bold: modelData.bold
            }
        }
    }
}
