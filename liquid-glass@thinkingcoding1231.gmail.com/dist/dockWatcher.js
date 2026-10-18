import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { DashManager } from './dockManager.js';
import { DhruvaDock } from './dhruvaDock.js';
const SEARCH_DELAY_MS = 2000;
const RESCAN_IDLE_TICKS = 2;
const RESCAN_INTERVAL_MS = 2000;
// The actors Dash to Dock and Dhruva add to the UI group for each dock.
const DOCK_ROOTS = ['dashtodockContainer', 'DhruvaContainer'];

/**
 * Finds Dash to Dock's and Dhruva's docks and gives each its glass. Either may create its dock after we are enabled,
 * and recreates it when monitors change, when it is enabled again and for some of its settings, so it is looked for
 * after a delay and again whenever one may have appeared.
 */
export class DockWatcher {
    _path;
    _settings;
    _logger;
    _icons;
    _docks = [];
    _searchId = 0;
    _rescanId = 0;
    _monitorsChangedId = 0;
    _childAddedId = 0;

    constructor(_path, _settings, _logger, _icons) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._icons = _icons;
    }

    setup() {
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRescan());
        this._childAddedId = Main.layoutManager.uiGroup.connect('child-added', (_group, child) => {
            if (DOCK_ROOTS.includes(child.get_name() ?? ''))
                this._scheduleRescan();
        });
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchId = 0;
            this._find();
            this._scheduleRescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    cleanup() {
        Main.layoutManager.disconnect(this._monitorsChangedId);
        Main.layoutManager.uiGroup.disconnect(this._childAddedId);
        if (this._searchId)
            GLib.Source.remove(this._searchId);
        this._searchId = 0;
        if (this._rescanId)
            GLib.Source.remove(this._rescanId);
        this._rescanId = 0;
        for (const entry of [...this._docks])
            this._release(entry);
    }

    _containers() {
        const found = [];
        const walk = (actor) => {
            if (actor === global.window_group)
                return;
            if (actor instanceof St.Widget && actor.get_name() === 'dashtodockDashContainer') {
                found.push({ container: actor, dhruva: false });
                return;
            }
            if (actor.get_name() === 'DhruvaContainer') {
                found.push({ container: actor, dhruva: true });
                return;
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(Main.layoutManager.uiGroup);
        return found;
    }

    // True when a dock was found that had no glass yet.
    _find() {
        let added = 0;
        for (const { container, dhruva } of this._containers()) {
            if (this._docks.some(entry => entry.container === container))
                continue;
            const manager = dhruva
                ? new DhruvaDock(this._path, container, this._settings, this._logger)
                : new DashManager(this._path, container, this._settings, this._logger);
            manager.setup();
            if (!dhruva)
                this._icons.watchDock(container);
            const entry = { container, manager, icons: !dhruva, destroyId: 0 };
            entry.destroyId = container.connect('destroy', () => {
                entry.destroyId = 0;
                this._release(entry);
                this._scheduleRescan();
            });
            this._docks.push(entry);
            added++;
        }
        if (added > 0)
            this._logger.log(`[Liquid Glass] Docks with glass: ${this._docks.length}`);
        return added > 0;
    }

    _release(entry) {
        this._docks = this._docks.filter(e => e !== entry);
        if (entry.destroyId)
            entry.container.disconnect(entry.destroyId);
        entry.destroyId = 0;
        entry.manager.cleanup();
        if (entry.icons)
            this._icons.unwatchDock(entry.container);
    }

    // Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new.
    _scheduleRescan() {
        if (this._rescanId)
            GLib.Source.remove(this._rescanId);
        let idleTicks = 0;
        this._rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
            idleTicks = this._find() ? 0 : idleTicks + 1;
            if (idleTicks < RESCAN_IDLE_TICKS)
                return GLib.SOURCE_CONTINUE;
            this._rescanId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
