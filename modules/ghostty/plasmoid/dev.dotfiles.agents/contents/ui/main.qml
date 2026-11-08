// The Agents panel widget: the hub's agents as counts in the panel and an
// inbox to act from, in place of desktop pop-ups. Everything it shows and
// does goes through `ghostty-hub tray` (hub/tray.mjs): a snapshot every two
// seconds, `seen` when the inbox opens, `act` for a button, `hub` for the
// link. AGENT_TRAY_HUB points it at another ghostty-hub, for testing.
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasma5support as P5Support
import org.kde.taskmanager as TaskManager
import "mocha.js" as M

PlasmoidItem {
    id: root

    property var snap: ({ counts: {}, items: [], unseen: false, alert: false })
    property bool flashing: false
    property color flashColor: M.peach
    // Ids of ▲ and ✗ items that already flashed, so each flashes once.
    property var flashed: ({})
    property string message: ""
    property bool messageOk: true
    property var pending: ({})
    // Settings › Tray, from the last snapshot; these stand in until the first.
    function setting(name, fallback) {
        return (snap.settings && snap.settings[name] !== undefined) ? snap.settings[name] : fallback
    }
    property int calls: 0

    readonly property string hub: "\"${AGENT_TRAY_HUB:-$HOME/.config/ghostty/bin/ghostty-hub}\""

    preferredRepresentation: compactRepresentation
    toolTipMainText: "Agents"
    toolTipSubText: {
        const c = snap.counts || {}
        const parts = [[c.you, "need you"], [c.broke, "broke"], [c.work, "working"], [c.watch, "watching"], [c.done, "done"]]
        const said = parts.filter(p => p[0] > 0).map(p => p[0] + " " + p[1])
        return said.length ? said.join(" · ") : "Nothing running"
    }

    // Runs `ghostty-hub tray <args>` and hands its output to handle(). Each
    // call is its own source, so two of the same command don't merge.
    function tray(kind, args) {
        calls += 1
        const cmd = hub + " tray " + args + " #" + calls
        pending[cmd] = kind
        exec.connectSource(cmd)
    }
    function quote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'"
    }

    function handle(kind, out) {
        let data = null
        try {
            data = JSON.parse(out)
        } catch (e) {
            if (kind !== "seen") console.warn("agents: bad output from tray " + kind + ": " + out)
        }
        if (kind === "snapshot" && data) {
            snap = data
            flashIfNew(data.items || [])
        } else if (kind === "seen") {
            tray("snapshot", "snapshot")
        } else if (kind === "act" && data) {
            message = data.message || ""
            messageOk = !!data.ok
            clearMessage.restart()
            if (data.raise) {
                raiseGhostty()
                root.expanded = false
            }
            tray("snapshot", "snapshot")
        }
    }

    // A ▲ or ✗ item seen for the first time fills the chip with its colour
    // for as long as Settings says (two seconds, or never at 0); that, and
    // the ring, replace the pop-up.
    function flashIfNew(items) {
        const now = {}
        let fresh = null
        for (const it of items) {
            if (it.section !== "you" && it.section !== "broke") continue
            now[it.id] = true
            if (it.new && !flashed[it.id] && (!fresh || it.section === "broke")) fresh = it
        }
        flashed = Object.assign(now, {})
        if (fresh && !root.expanded && flashOff.interval > 0) {
            flashColor = M.section[fresh.section]
            flashing = true
            flashOff.restart()
        }
    }

    // Brings Ghostty to the front. Only the panel can raise a window on
    // Wayland, so the tray command switches the tab and this raises it.
    function raiseGhostty() {
        for (let i = 0; i < tasks.count; i++) {
            const idx = tasks.index(i, 0)
            const app = String(tasks.data(idx, TaskManager.AbstractTasksModel.AppId) || "")
            if (app.toLowerCase().indexOf("ghostty") >= 0) {
                tasks.requestActivate(idx)
                return
            }
        }
    }

    TaskManager.TasksModel {
        id: tasks
        filterByVirtualDesktop: false
        filterByActivity: false
        filterByScreen: false
        groupMode: TaskManager.TasksModel.GroupDisabled
    }

    P5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []
        onNewData: (source, data) => {
            const kind = root.pending[source]
            delete root.pending[source]
            disconnectSource(source)
            root.handle(kind, data["stdout"] || "")
        }
    }

    Timer {
        interval: root.setting("pollMs", 2000)
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.tray("snapshot", "snapshot")
    }
    Timer {
        id: flashOff
        interval: root.setting("flashMs", 2000)
        onTriggered: root.flashing = false
    }
    Timer {
        id: clearMessage
        interval: root.setting("messageMs", 6000)
        onTriggered: root.message = ""
    }

    onExpandedChanged: {
        if (expanded) {
            flashing = false
            tray("seen", "seen")
        }
    }

    compactRepresentation: MouseArea {
        readonly property int size: Math.max(11, Math.min(15, Math.round(height * 0.42)))
        Layout.minimumWidth: chip.implicitWidth + 8
        Layout.preferredWidth: chip.implicitWidth + 8
        hoverEnabled: true
        onClicked: root.expanded = !root.expanded

        Chip {
            id: chip
            anchors.centerIn: parent
            counts: root.snap.counts || {}
            ring: root.snap.unseen && !root.expanded
            flashing: root.flashing
            flashColor: root.flashColor
            fontSize: parent.size
        }
    }

    fullRepresentation: Inbox {
        id: inbox
        Layout.preferredWidth: root.setting("inboxWidth", 600)
        Layout.minimumWidth: root.setting("inboxWidth", 600)
        maxHeight: root.setting("inboxHeight", 720)
        boxWidth: root.setting("inboxWidth", 600)
        Layout.preferredHeight: implicitHeight
        Layout.minimumHeight: Math.min(implicitHeight, 200)
        snap: root.snap
        message: root.message
        messageOk: root.messageOk
        onAct: (action, id) => root.tray("act", "act " + action + " " + root.quote(id))
        onOpenHub: root.tray("act", "hub")
        onClose: root.expanded = false
        Connections {
            target: root
            function onExpandedChanged() {
                if (root.expanded) {
                    inbox.sel = 0
                    inbox.showDone = root.setting("foldDone", true) === false
                    inbox.forceActiveFocus()
                }
            }
        }
    }
}
