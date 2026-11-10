// The inbox: every item from the tray command in sections, needs-you first,
// each with how long it has been so and its buttons. A button that answers
// or approves is filled in its section's colour, one that opens something is
// blue, one that turns it down is grey; ↵ presses the first, 1 2 3 the first
// three, x dismisses, j and k move. A babysitter's reply shows the text it
// would post. Done items fold into one line until shown.
import QtQuick
import QtQuick.Layouts
import "mocha.js" as M

Rectangle {
    id: inbox

    property var snap: ({ counts: {}, items: [] })
    property string message: ""
    property bool messageOk: true
    property bool showDone: false
    property int sel: 0
    property int maxHeight: 720
    property int boxWidth: 600

    signal act(string action, string id)
    signal openHub()
    signal close()

    readonly property var sections: [
        { key: "you", label: "▲ NEEDS YOU" },
        { key: "broke", label: "✗ BROKE" },
        { key: "work", label: "✻ WORKING" },
        { key: "watch", label: "◉ WATCHING" }
    ]
    function itemsOf(key) {
        return (snap.items || []).filter(i => i.section === key)
    }
    readonly property var doneItems: itemsOf("done")
    // The rows j and k move through, in the order they're drawn.
    readonly property var rows: {
        const out = []
        for (const s of sections) out.push(...itemsOf(s.key))
        if (showDone) out.push(...doneItems)
        return out
    }
    readonly property var current: rows.length ? rows[Math.min(sel, rows.length - 1)] : null
    readonly property string currentId: current ? current.id : ""

    color: M.mantle
    radius: 8
    border.width: 1
    border.color: M.surface1
    implicitWidth: boxWidth
    implicitHeight: Math.min(col.implicitHeight + 24, maxHeight)
    focus: true

    Keys.onPressed: event => {
        const k = event.key
        if (k === Qt.Key_J || k === Qt.Key_Down) sel = Math.min(rows.length - 1, sel + 1)
        else if (k === Qt.Key_K || k === Qt.Key_Up) sel = Math.max(0, sel - 1)
        else if ((k === Qt.Key_Return || k === Qt.Key_Enter) && current) act(current.actions[0] || "go", current.id)
        else if ((k === Qt.Key_1 || k === Qt.Key_2 || k === Qt.Key_3) && current) {
            const a = current.actions[k - Qt.Key_1]
            if (a) act(a, current.id)
        } else if (k === Qt.Key_X && current) act("dismiss", current.id)
        else if (k === Qt.Key_Escape) close()
        else return
        event.accepted = true
    }

    // One action button with the key that presses it: filled in `fill` for
    // an answer, a blue outline to open something, a grey one otherwise.
    component ActButton: Rectangle {
        id: b
        property string label
        property string look: "plain"
        property color fill: M.peach
        property string keyHint: ""
        signal clicked()

        readonly property color ink: look === "fill" ? M.crust : look === "blue" ? M.blue : M.subtext1
        implicitWidth: br.implicitWidth + 16
        implicitHeight: 24
        radius: 6
        color: look === "fill" ? (ma.containsMouse ? Qt.lighter(fill, 1.1) : fill) : ma.containsMouse ? M.surface0 : "transparent"
        border.width: look === "fill" ? 0 : 1
        border.color: look === "blue" ? M.blue : M.surface1

        Row {
            id: br
            anchors.centerIn: parent
            spacing: 6
            Text {
                text: b.label
                color: b.ink
                font.pixelSize: 12
                font.weight: b.look === "plain" ? Font.Medium : Font.DemiBold
            }
            Text {
                text: b.keyHint
                visible: b.keyHint !== ""
                color: b.ink
                opacity: 0.65
                font.family: M.mono
                font.pixelSize: 11
            }
        }
        MouseArea {
            id: ma
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: b.clicked()
        }
    }

    readonly property var labels: ({
        allow: "Allow", deny: "Deny", go: "Go", dismiss: "Dismiss",
        post: "Post", edit: "Edit", skip: "Skip", push: "Push", review: "Review",
        run: "Run", retry: "Retry", approve: "Approve", move: "Move", again: "Try again"
    })
    readonly property var fills: ["allow", "post", "push", "run", "retry", "approve", "move", "again"]
    readonly property var blues: ["go", "edit", "review"]
    function lookOf(action) {
        return fills.indexOf(action) >= 0 ? "fill" : blues.indexOf(action) >= 0 ? "blue" : "plain"
    }

    // A row's buttons, in order, with their keys.
    component Buttons: Row {
        id: bs
        required property var item
        spacing: 5
        Repeater {
            model: bs.item.actions
            ActButton {
                required property string modelData
                required property int index
                label: inbox.labels[modelData] || modelData
                look: inbox.lookOf(modelData)
                fill: M.section[bs.item.section] || M.peach
                keyHint: index < 3 ? String(index + 1) : ""
                onClicked: inbox.act(modelData, bs.item.id)
            }
        }
    }

    // One item: its glyph in a square of its section's colour, its title and
    // where it is, and its buttons: on the right, or under it when there are
    // three or a reply to show.
    component ItemRow: Rectangle {
        id: r
        required property var item
        readonly property bool loud: item.section === "you" || item.section === "broke"
        readonly property bool selected: inbox.currentId === item.id
        readonly property bool below: !!item.preview || (item.actions || []).length > 2

        Layout.fillWidth: true
        implicitHeight: rc.implicitHeight + (below ? 10 : item.section === "work" ? 6 : 10)
        radius: 6
        color: selected ? M.surface0 : (M.tint[item.section] || "transparent")

        MouseArea {
            anchors.fill: parent
            onClicked: inbox.sel = Math.max(0, inbox.rows.findIndex(x => x.id === r.item.id))
        }
        ColumnLayout {
            id: rc
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: 5
        RowLayout {
            id: rl
            Layout.fillWidth: true
            Layout.leftMargin: 8
            Layout.rightMargin: 8
            spacing: 10
            Rectangle {
                Layout.preferredWidth: 20
                Layout.preferredHeight: 20
                radius: 5
                color: M.section[r.item.section]
                Text {
                    anchors.centerIn: parent
                    text: r.item.glyph
                    color: M.crust
                    font.pixelSize: 12
                    font.bold: true
                }
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0
                Text {
                    Layout.fillWidth: true
                    text: String(r.item.title).replace(/\s+/g, " ")
                    textFormat: Text.PlainText
                    color: M.text
                    font.pixelSize: 13
                    font.weight: r.loud ? Font.DemiBold : Font.Normal
                    elide: Text.ElideRight
                }
                Text {
                    Layout.fillWidth: true
                    text: String(r.item.meta).replace(/\s+/g, " ")
                    textFormat: Text.PlainText
                    visible: text !== ""
                    color: M.subtext0
                    font.pixelSize: 12
                    elide: Text.ElideRight
                }
            }
            Text {
                Layout.alignment: Qt.AlignTop
                text: r.item.age || ""
                visible: text !== ""
                color: M.subtext0
                font.family: M.mono
                font.pixelSize: 11
            }
            Buttons {
                item: r.item
                visible: !r.below
            }
        }
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 38
            Layout.rightMargin: 8
            visible: !!r.item.preview
            implicitHeight: pv.implicitHeight + 12
            radius: 5
            color: M.crust
            Text {
                id: pv
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 8
                anchors.rightMargin: 8
                text: "“" + String(r.item.preview || "").replace(/\s+/g, " ") + "”"
                textFormat: Text.PlainText
                color: M.subtext1
                font.pixelSize: 12
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
            }
        }
        Buttons {
            item: r.item
            visible: r.below
            Layout.leftMargin: 38
        }
        }
    }

    Flickable {
        anchors.fill: parent
        anchors.margins: 12
        contentHeight: col.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ColumnLayout {
            id: col
            width: parent.width
            spacing: 9

            RowLayout {
                Layout.fillWidth: true
                spacing: 14
                Text {
                    text: "Agents"
                    color: M.text
                    font.pixelSize: 15
                    font.bold: true
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: "Meta+A"
                    color: M.subtext0
                    font.family: M.mono
                    font.pixelSize: 12
                }
                Text {
                    text: "Open hub ↗"
                    color: M.blue
                    font.pixelSize: 13
                    font.underline: hub.containsMouse
                    MouseArea {
                        id: hub
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: inbox.openHub()
                    }
                }
            }

            Repeater {
                model: inbox.sections
                ColumnLayout {
                    id: sec
                    required property var modelData
                    readonly property var items: inbox.itemsOf(modelData.key)
                    visible: items.length > 0
                    Layout.fillWidth: true
                    spacing: 3
                    RowLayout {
                        Layout.fillWidth: true
                        Text {
                            text: sec.modelData.label
                            color: M.section[sec.modelData.key]
                            font.family: M.mono
                            font.pixelSize: 12
                            font.bold: true
                        }
                        Item { Layout.fillWidth: true }
                        Text {
                            text: sec.items.length
                            color: M.subtext0
                            font.family: M.mono
                            font.pixelSize: 12
                        }
                    }
                    Repeater {
                        model: sec.items
                        ItemRow {
                            required property var modelData
                            item: modelData
                        }
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                visible: inbox.doneItems.length > 0
                implicitHeight: 30
                radius: 6
                color: M.base
                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 4
                    spacing: 6
                    Text {
                        text: "✓ " + inbox.doneItems.length + " done"
                        color: M.green
                        font.pixelSize: 13
                        font.bold: true
                    }
                    Text {
                        text: "leave once you open them"
                        color: M.subtext0
                        font.pixelSize: 13
                    }
                    Item { Layout.fillWidth: true }
                    ActButton {
                        label: inbox.showDone ? "Hide" : "Show"
                        onClicked: inbox.showDone = !inbox.showDone
                    }
                }
            }
            // Spaced like the rows in a section, not like the sections.
            ColumnLayout {
                Layout.fillWidth: true
                Layout.topMargin: -6
                visible: inbox.showDone && inbox.doneItems.length > 0
                spacing: 3
                Repeater {
                    model: inbox.showDone ? inbox.doneItems : []
                    ItemRow {
                        required property var modelData
                        item: modelData
                    }
                }
            }

            Text {
                Layout.fillWidth: true
                Layout.topMargin: 6
                Layout.bottomMargin: 6
                visible: (inbox.snap.items || []).length === 0
                horizontalAlignment: Text.AlignHCenter
                text: "All quiet. No agent is running."
                color: M.subtext0
                font.italic: true
                font.pixelSize: 13
            }

            RowLayout {
                Layout.fillWidth: true
                Text {
                    Layout.fillWidth: true
                    text: inbox.message
                    visible: text !== ""
                    color: inbox.messageOk ? M.green : M.red
                    font.pixelSize: 12
                    elide: Text.ElideRight
                }
                Item {
                    Layout.fillWidth: true
                    visible: inbox.message === ""
                }
                Text {
                    text: "j k move · ↵ first button · 1 2 3 buttons · x dismiss"
                    color: M.overlay1
                    font.family: M.mono
                    font.pixelSize: 11
                }
            }
        }
    }
}
