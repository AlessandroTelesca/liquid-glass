import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { TopBarManager } from './topBarManager.js';
// Built like the shell's Panel, whose three boxes the glass follows.
function isTopBar(actor) {
    return actor instanceof St.Widget
        && '_leftBox' in actor && actor._leftBox instanceof St.BoxLayout
        && '_centerBox' in actor && actor._centerBox instanceof St.BoxLayout
        && '_rightBox' in actor && actor._rightBox instanceof St.BoxLayout;
}
/**
 * Top bar glass for the bars other extensions put on further monitors, such as Multi Monitors Bar.
 * Each bar sits in a box of its own in uiGroup and gets its own TopBarManager, which follows the
 * top bar settings. Bars along a side of the screen are left alone: the glass is laid out for a
 * horizontal bar.
 */
export class ExtraTopBarManager {
    _path;
    _settings;
    _logger;
    _disconnects = [];
    _bars = new Map();
    _idleId = 0;
    _attached = 0;
    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }
    setup() {
        const uiGroup = Main.layoutManager.uiGroup;
        // The shell's own signal emitters type their handlers as returning a stop flag.
        const scan = () => {
            this._scheduleScan();
            return undefined;
        };
        // A bar's box is added to uiGroup before the bar is put in it; the scan waits for an idle.
        for (const signal of ['child-added', 'child-removed']) {
            const id = uiGroup.connect(signal, scan);
            this._disconnects.push(() => uiGroup.disconnect(id));
        }
        const monitorsId = Main.layoutManager.connect('monitors-changed', scan);
        this._disconnects.push(() => Main.layoutManager.disconnect(monitorsId));
        const extensionsId = Main.extensionManager.connect('extension-state-changed', scan);
        this._disconnects.push(() => Main.extensionManager.disconnect(extensionsId));
        // The shell destroys uiGroup on shutdown without disabling extensions; a scan queued by the
        // removal of its children would run on disposed actors.
        const destroyId = uiGroup.connect('destroy', () => this.cleanup());
        this._disconnects.push(() => uiGroup.disconnect(destroyId));
        this._scheduleScan();
    }
    _scheduleScan() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }
    _scan() {
        const found = new Map();
        for (const box of Main.layoutManager.uiGroup.get_children()) {
            if (box === Main.layoutManager.panelBox || !(box instanceof St.Widget))
                continue;
            for (const child of box.get_children()) {
                if (!isTopBar(child) || child.has_style_class_name('multimonitor-panel-vertical'))
                    continue;
                found.set(child, box);
            }
        }
        for (const panel of [...this._bars.keys()])
            if (!found.has(panel))
                this._detach(panel);
        for (const [panel, box] of found) {
            if (this._bars.has(panel))
                continue;
            const manager = new TopBarManager(this._path, this._settings, this._logger, panel, box, `top-bar:${++this._attached}`);
            // These bars belong to other extensions and may not be built the way TopBarManager expects.
            try {
                manager.setup();
            }
            catch (e) {
                manager.cleanup();
                this._logger.log(`[Liquid Glass] Could not attach glass to another top bar: ${e}`);
                continue;
            }
            // The glass and the styles must go while the bar's actors still exist.
            const destroyId = panel.connect('destroy', () => this._detach(panel));
            // Multi Monitors Bar marks a bar it moves to a side of the screen.
            const styleId = panel.connect('notify::style-class', () => this._scheduleScan());
            this._bars.set(panel, { manager, signalIds: [destroyId, styleId] });
        }
    }
    _detach(panel) {
        const bar = this._bars.get(panel);
        if (!bar)
            return;
        this._bars.delete(panel);
        for (const id of bar.signalIds)
            panel.disconnect(id);
        bar.manager.cleanup();
    }
    cleanup() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const disconnect of this._disconnects)
            disconnect();
        this._disconnects = [];
        for (const panel of [...this._bars.keys()])
            this._detach(panel);
    }
}
