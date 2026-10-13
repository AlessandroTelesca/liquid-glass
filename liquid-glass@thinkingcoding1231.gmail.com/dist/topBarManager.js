import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isActorValid } from './actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { hexToColorArray } from './animation/colors.js';
import { sanitizeColorPreference } from './contrastSampler.js';
import { AdaptiveTextColor } from './adaptiveText.js';
// Extra space for shader edge effects.
const SHADER_PADDING = 20;
// Space for the pill shadow.
const SHADOW_ROOM = 48;
const SIDES = ['top', 'bottom', 'left', 'right'];

function sanitizeStyle(value) {
    return value === 'pill' || value === 'islands' ? value : 'off';
}

/** Glass behind the top bar: one pill or separate islands for its three button groups. */
export class TopBarManager {
    _path;
    _settings;
    _logger;
    _style = 'off';
    _glass = null;
    _settingsIds = [];
    _frameSyncId = 0;
    _frameSignalId = 0;
    _lastKey = '';
    _lastIslandRects = [];
    _islandGeometryHoldFrames = 0;
    _text;
    // Original styles for the panel and its boxes.
    _savedStyles = [];
    _childrenStyles = [];
    _panelStyleId = 0;
    _margin = { top: 0, bottom: 0, left: 0, right: 0 };
    _padding = { top: 0, bottom: 0, left: 0, right: 0 };
    _boxSignalIds = [];
    _containerSignalIds = [];
    _containerTargets = [];
    _forwardedPresses = new Map();
    _stagePointerSignalId = 0;
    _applyingLayout = false;

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._text = new AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []), _logger, 'top bar');
    }

    setup() {
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        watch('top-bar-style', () => this._apply());
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
            watch(`top-bar-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`top-bar-${key}`, () => this._syncText());
        for (const side of SIDES) {
            watch(`top-bar-margin-${side}`, () => this._applyLayout());
            watch(`top-bar-padding-${side}`, () => this._applyLayout());
        }
        this._apply();
    }

    _key(suffix) {
        return `top-bar-${suffix}`;
    }

    _apply() {
        const style = sanitizeStyle(this._settings.get_string('top-bar-style'));
        if (style === this._style)
            return;
        this._remove();
        this._style = style;
        if (style !== 'off')
            this._create();
    }

    _create() {
        const panel = Main.panel;
        const panelBox = Main.layoutManager.panelBox;
        panel.add_style_class_name('liquid-glass-transparent');
        const glass = new BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'top-bar',
        });
        this._glass = glass;
        glass.reactive = false;
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setMultiRegionMode(this._style === 'islands');
        glass.setShadowMaxRadius(SHADOW_ROOM - 8);
        // Draw the glass below the panel.
        Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
        this._applyMaterial();
        this._lastKey = '';
        this._lastIslandRects = [];
        this._islandGeometryHoldFrames = 0;
        this._savedStyles = [panel, panel._leftBox, panel._centerBox, panel._rightBox].map(actor => [actor, actor.get_style()]);
        this._childrenStyles = [];
        // Reapply layout when the theme changes the bar height.
        this._panelStyleId = panel.connect('style-changed', () => this._applyLayout());
        this._applyLayout();
        this._connectBoxSignals();
        this._stagePointerSignalId = global.stage.connect('captured-event', (_actor, event) => {
            this._trackNativePress(event);
            const result = this._handleTrackedRelease(event);
            this._syncForwardedHover();
            return result;
        });
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            // The glass may be destroyed before shutdown cleanup runs.
            alive: () => !!this._glass && isActorValid(this._glass),
            honourFreeze: true,
            errorTag: 'TopBarManager',
            step: () => {
                ensureGlassAllocated(this._glass);
                this._sync();
            },
        });
        ensureGlassAllocated(this._glass);
        this._sync();
        this._syncText();
    }

    _connectBoxSignals() {
        const panel = Main.panel;
        const boxes = [panel._leftBox, panel._centerBox, panel._rightBox];
        for (const box of boxes) {
            if (!box)
                continue;
            const addedId = box.connect('child-added', (_container, child) => {
                if (child instanceof St.Widget) {
                    this._applyLayout();
                }
            });
            const removedId = box.connect('child-removed', (_container, child) => {
                if (child instanceof St.Widget) {
                    const styleEntry = this._childrenStyles.find(([actor]) => actor === child);
                    if (styleEntry)
                        child.set_style(styleEntry[1]);
                    this._childrenStyles = this._childrenStyles.filter(([actor]) => actor !== child);
                }
            });
            this._boxSignalIds.push([box, addedId], [box, removedId]);
        }
    }

    _disconnectBoxSignals() {
        for (const [box, id] of this._boxSignalIds) {
            if (isActorValid(box)) {
                box.disconnect(id);
            }
        }
        this._boxSignalIds = [];
    }

    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        glass.setTintColor(...hexToColorArray(this._settings.get_string(this._key('tint-color'))));
        glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
        glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
        glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
        glass.setBrightness(this._settings.get_double(this._key('brightness')));
        glass.setContrast(this._settings.get_double(this._key('contrast')));
        glass.setSaturation(this._settings.get_double(this._key('saturation')));
    }

    _insets(kind) {
        return Object.fromEntries(SIDES.map(side => [side, this._settings.get_int(this._key(`${kind}-${side}`))]));
    }

    // Forward events from the full-height wrapper to the panel button.
    _targetMenu(target) {
        const anyTarget = target;
        const menu = anyTarget.menu ?? anyTarget._delegate?.menu;
        return menu && typeof menu.toggle === 'function' ? menu : null;
    }

    _triggerClick(target, event) {
        if (!isActorValid(target))
            return;
        const isTouch = event.type() === Clutter.EventType.TOUCH_END;
        const menu = this._targetMenu(target);
        // Let a custom release/touch handler run before falling back to the menu.
        if (menu) {
            const signal = isTouch ? 'touch-event' : 'button-release-event';
            // Clutter returns an event result at runtime, though GObject types this as void.
            const handled = target.emit(signal, event.copy());
            if (handled === Clutter.EVENT_STOP)
                return;
            menu.toggle();
            return;
        }
        // target.event() keeps the wrapper as the source; some panel buttons reject it.
        if (target instanceof St.Button) {
            target.emit('clicked', event.get_button ? event.get_button() : 1);
            return;
        }
        // Forward release to controls activated by their own release handler.
        target.emit(isTouch ? 'touch-event' : 'button-release-event', event.copy());
    }

    _eventComesFromTarget(target, event) {
        let source = event.get_source();
        while (source) {
            if (source === target)
                return true;
            source = source.get_parent();
        }
        return false;
    }

    _pointerIsOverContainer(container) {
        const [x, y] = global.get_pointer();
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor) {
            if (actor === container)
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    _syncForwardedHover() {
        for (const [container, target] of this._containerTargets) {
            if (!isActorValid(container) || !isActorValid(target))
                continue;
            if (this._pointerIsOverContainer(container)) {
                target.add_style_pseudo_class('hover');
            }
            else {
                // Overlays can suppress leave-event; clear synthetic state when the pointer leaves.
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
                this._forwardedPresses.delete(container);
            }
        }
    }

    _trackNativePress(event) {
        const type = event.type();
        const isTouch = type === Clutter.EventType.TOUCH_BEGIN;
        if (type !== Clutter.EventType.BUTTON_PRESS && !isTouch)
            return;
        if (!isTouch && event.get_button() !== 1)
            return;
        // Layout changes can move the picked actor between press and release; track native presses.
        for (const [container, target] of this._containerTargets) {
            if (!this._eventComesFromTarget(target, event))
                continue;
            this._forwardedPresses.set(container, {
                button: isTouch ? 1 : event.get_button(),
                touch: isTouch,
                nativePress: true,
            });
            return;
        }
    }

    _handleTrackedRelease(event) {
        const type = event.type();
        const isTouchEnd = type === Clutter.EventType.TOUCH_END;
        if (type !== Clutter.EventType.BUTTON_RELEASE && !isTouchEnd)
            return Clutter.EVENT_PROPAGATE;
        for (const [container, forwardedPress] of this._forwardedPresses) {
            if (forwardedPress.touch !== isTouchEnd)
                continue;
            if (!forwardedPress.touch && event.get_button() !== forwardedPress.button)
                continue;
            const target = this._containerTargets.find(([candidate]) => candidate === container)?.[1];
            this._forwardedPresses.delete(container);
            if (!target || !isActorValid(target))
                return Clutter.EVENT_STOP;
            // Preserve native events when both halves reach the button; otherwise finish the wrapper press.
            if (forwardedPress.nativePress && this._eventComesFromTarget(target, event))
                return Clutter.EVENT_PROPAGATE;
            // A menu may already have toggled on press; avoid toggling it twice.
            if (forwardedPress.nativePress && this._targetMenu(target)) {
                target.remove_style_pseudo_class('active');
                return Clutter.EVENT_PROPAGATE;
            }
            target.remove_style_pseudo_class('active');
            if (!this._pointerIsOverContainer(container))
                return Clutter.EVENT_PROPAGATE;
            if (target.get_name() === 'panelActivities') {
                const overview = Main.overview;
                if (typeof overview.shouldToggleByCornerOrButton !== 'function' || overview.shouldToggleByCornerOrButton())
                    overview.toggle();
            }
            else if (forwardedPress.touch || isTouchEnd) {
                if (this._targetMenu(target)) {
                    this._triggerClick(target, event);
                }
                else if (target instanceof St.Button) {
                    target.emit('clicked', 1);
                }
                else {
                    target.emit('touch-event', event.copy());
                }
            }
            else {
                this._triggerClick(target, event);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _setupContainerForwarding(container, target) {
        if (this._containerSignalIds.some(([actor]) => actor === container))
            return;
        const enterId = container.connect('enter-event', () => {
            if (isActorValid(target))
                target.add_style_pseudo_class('hover');
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = container.connect('leave-event', () => {
            if (isActorValid(target) && !this._pointerIsOverContainer(container)) {
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
            }
            return Clutter.EVENT_PROPAGATE;
        });
        const targetLeaveId = target.connect('leave-event', () => {
            if (isActorValid(target) && !this._pointerIsOverContainer(container)) {
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
            }
            return Clutter.EVENT_PROPAGATE;
        });
        const pressId = container.connect('captured-event', (_actor, event) => {
            const type = event.type();
            const isTouch = type === Clutter.EventType.TOUCH_BEGIN;
            if (type !== Clutter.EventType.BUTTON_PRESS && !isTouch)
                return Clutter.EVENT_PROPAGATE;
            if (!isActorValid(target))
                return Clutter.EVENT_PROPAGATE;
            const isActivitiesButton = target.get_name() === 'panelActivities';
            const hasTargetMenu = !!this._targetMenu(target);
            // Let real-button events follow the normal path; forward only wrapper-intercepted events.
            if (this._eventComesFromTarget(target, event))
                return Clutter.EVENT_PROPAGATE;
            if (!isTouch && event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._forwardedPresses.set(container, {
                button: isTouch ? 1 : event.get_button(),
                touch: isTouch,
                nativePress: false,
            });
            target.add_style_pseudo_class('active');
            if (isActivitiesButton || hasTargetMenu) {
                // Activate menu and Activities buttons on release to avoid double toggles.
            }
            else if (isTouch) {
                // Forward touch to the widget's own handler.
                target.emit('touch-event', event.copy());
            }
            else {
                // Preserve press/release pairing for custom release handlers.
                target.emit('button-press-event', event.copy());
            }
            return Clutter.EVENT_STOP;
        });
        const releaseId = container.connect('captured-event', (_actor, event) => {
            const type = event.type();
            const isTouchEnd = type === Clutter.EventType.TOUCH_END;
            if (type !== Clutter.EventType.BUTTON_RELEASE && !isTouchEnd)
                return Clutter.EVENT_PROPAGATE;
            const forwardedPress = this._forwardedPresses.get(container);
            const eventFromTarget = this._eventComesFromTarget(target, event);
            // Leave native sequences alone; pair wrapper-intercepted presses here.
            if (!forwardedPress && eventFromTarget)
                return Clutter.EVENT_PROPAGATE;
            if (!forwardedPress)
                return Clutter.EVENT_PROPAGATE;
            if (!isActorValid(target)) {
                this._forwardedPresses.delete(container);
                return Clutter.EVENT_STOP;
            }
            if (!forwardedPress.touch && !isTouchEnd && event.get_button() !== forwardedPress.button) {
                return Clutter.EVENT_PROPAGATE;
            }
            this._forwardedPresses.delete(container);
            target.remove_style_pseudo_class('active');
            const isActivitiesButton = target.get_name() === 'panelActivities';
            if (isActivitiesButton) {
                const overview = Main.overview;
                if (typeof overview.shouldToggleByCornerOrButton !== 'function' || overview.shouldToggleByCornerOrButton())
                    overview.toggle();
            }
            else if (forwardedPress.touch || isTouchEnd) {
                if (this._targetMenu(target)) {
                    this._triggerClick(target, event);
                }
                else if (target instanceof St.Button) {
                    target.emit('clicked', 1);
                }
                else {
                    target.emit('touch-event', event.copy());
                }
            }
            else {
                // Use the menu when available; otherwise forward release to the widget.
                this._triggerClick(target, event);
            }
            this._syncForwardedHover();
            return Clutter.EVENT_STOP;
        });
        this._containerTargets.push([container, target]);
        this._containerSignalIds.push([container, enterId], [container, leaveId], [target, targetLeaveId], [container, pressId], [container, releaseId]);
    }

    _disconnectContainerSignals() {
        for (const [container, id] of this._containerSignalIds) {
            if (isActorValid(container))
                container.disconnect(id);
        }
        this._containerSignalIds = [];
        this._containerTargets = [];
        this._forwardedPresses.clear();
        if (this._stagePointerSignalId) {
            try {
                if (isActorValid(global.stage))
                    global.stage.disconnect(this._stagePointerSignalId);
            }
            catch (e) {
                // The stage may already be shutting down.
            }
            this._stagePointerSignalId = 0;
        }
    }

    _applyLayout() {
        if (!this._glass || this._applyingLayout)
            return;
        this._applyingLayout = true;
        try {
            const panel = Main.panel;
            const margin = this._margin = this._insets('margin');
            const padding = this._padding = this._insets('padding');
            const top = margin.top + padding.top;
            const bottom = margin.bottom + padding.bottom;
            const panelEntry = this._savedStyles.find(([actor]) => actor === panel);
            const originalPanelStyle = panelEntry ? panelEntry[1] : null;
            const ownPanel = originalPanelStyle?.trim().replace(/;$/, '');
            panel.set_style(ownPanel || '');
            for (const [actor, original] of this._savedStyles) {
                if (!actor || actor === panel)
                    continue;
                actor.set_style(original?.trim().replace(/;$/, '') || '');
            }
            for (const [childActor, originalChildStyle] of this._childrenStyles) {
                if (childActor && childActor.set_style) {
                    childActor.set_style(originalChildStyle?.trim().replace(/;$/, '') || '');
                }
            }
            const themeHeight = panel.get_theme_node ? panel.get_theme_node().get_height() : 0;
            const [, naturalHeight] = panel.get_preferred_height(-1);
            const baseHeight = themeHeight > 0 ? themeHeight : naturalHeight;
            const totalHeight = baseHeight + top + bottom;
            const panelStyle = `height: ${totalHeight}px; min-height: ${totalHeight}px; padding-top: 0px; padding-bottom: 0px;`;
            panel.set_style(ownPanel ? `${ownPanel}; ${panelStyle}` : panelStyle);
            for (const [actor, original] of this._savedStyles) {
                if (!actor || actor === panel)
                    continue;
                const leftInset = actor === panel._leftBox ? margin.left + padding.left : 0;
                const rightInset = actor === panel._rightBox ? margin.right + padding.right : 0;
                const boxStyle = `height: ${totalHeight}px; padding: 0px ${rightInset}px 0px ${leftInset}px;`;
                const ownActor = original?.trim().replace(/;$/, '');
                actor.set_style(ownActor ? `${ownActor}; ${boxStyle}` : boxStyle);
                const children = actor.get_children();
                for (const child of children) {
                    if (!child.get_style_class_name)
                        continue;
                    let target = null;
                    const queue = [child];
                    while (queue.length > 0) {
                        const current = queue.shift();
                        if (current && current.get_style_class_name && current.has_style_class_name('panel-button')) {
                            target = current;
                            break;
                        }
                        if (current && current.get_children) {
                            queue.push(...current.get_children());
                        }
                    }
                    const actualTarget = target || child;
                    if (child !== actualTarget && child instanceof St.Widget) {
                        // Make the wrapper reactive so it can forward input from the top edge.
                        child.reactive = true;
                        if (!this._childrenStyles.some(([a]) => a === child)) {
                            this._childrenStyles.push([child, child.get_style()]);
                        }
                        const childEntry = this._childrenStyles.find(([a]) => a === child);
                        const originalChildStyle = childEntry ? childEntry[1] : null;
                        const ownChild = originalChildStyle?.trim().replace(/;$/, '');
                        const binStyle = `height: ${totalHeight}px;`;
                        child.set_style(ownChild ? `${ownChild}; ${binStyle}` : binStyle);
                        this._setupContainerForwarding(child, actualTarget);
                    }
                    if (!this._childrenStyles.some(([a]) => a === actualTarget)) {
                        if (actualTarget instanceof St.Widget) {
                            this._childrenStyles.push([actualTarget, actualTarget.get_style()]);
                        }
                    }
                    const targetEntry = this._childrenStyles.find(([a]) => a === actualTarget);
                    const originalTargetStyle = targetEntry ? targetEntry[1] : null;
                    const ownTarget = originalTargetStyle?.trim().replace(/;$/, '');
                    // Keep the button at its themed height inside the full-height wrapper.
                    const targetStyle = `height: ${baseHeight}px; margin-top: ${top}px; margin-bottom: ${bottom}px;`;
                    actualTarget.set_style(ownTarget ? `${ownTarget}; ${targetStyle}` : targetStyle);
                }
            }
        }
        finally {
            this._applyingLayout = false;
        }
    }

    _syncText() {
        if (!this._glass || !this._settings.get_boolean(this._key('enable-adaptive-text-color'))) {
            this._text.clear();
            return;
        }
        this._text.start(this._settings.get_int(this._key('sample-interval-ms')), sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))));
    }

    _textRoots() {
        const panel = Main.panel;
        return [panel._leftBox, panel._centerBox, panel._rightBox].filter(box => box && box.mapped);
    }

    // Visible child extent in bar coordinates.
    _boxExtent(box) {
        let x0 = Infinity, x1 = -Infinity;
        const [bx] = box.get_position();
        for (const child of box.get_children()) {
            if (!child.visible || child.width < 1)
                continue;
            const alloc = child.get_allocation_box();
            x0 = Math.min(x0, bx + alloc.x1);
            x1 = Math.max(x1, bx + alloc.x2);
        }
        return x1 > x0 ? [x0, x1] : null;
    }

    // Sync the glass beneath the panel, hiding it with the bar.
    _sync() {
        // Modal overlays may suppress leave-event; reconcile hover each frame.
        this._syncForwardedHover();
        const glass = this._glass;
        const panelBox = Main.layoutManager.panelBox;
        const panel = Main.panel;
        const shown = panelBox.visible && panelBox.mapped && panel.mapped;
        if (!shown) {
            if (glass.visible)
                glass.hide();
            return;
        }
        if (!glass.visible)
            glass.show();
        glass.opacity = Math.round(panelBox.opacity * panel.opacity / 255);
        const [x, y] = panelBox.get_transformed_position();
        const width = Math.round(panelBox.width);
        const height = Math.round(panel.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1)
            return;
        const { top, bottom } = this._margin;
        const pillHeight = height - top - bottom;
        const left = this._margin.left, right = width - this._margin.right;
        const rects = [];
        const textAnimating = this._style === 'islands' && this._text.isAnimating();
        if (textAnimating)
            this._islandGeometryHoldFrames = 4;
        else if (this._islandGeometryHoldFrames > 0)
            this._islandGeometryHoldFrames--;
        const holdIslandGeometry = textAnimating || this._islandGeometryHoldFrames > 0;
        if (this._style === 'pill') {
            rects.push([left, top, right - left, pillHeight]);
        }
        else if (holdIslandGeometry && this._lastIslandRects.length > 0) {
            // Text tweens can briefly disturb allocations; hold island geometry steady until they settle.
            rects.push(...this._lastIslandRects.map(rect => [...rect]));
        }
        else {
            for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
                const extent = this._boxExtent(box);
                if (!extent)
                    continue;
                const x0 = Math.max(extent[0] - this._padding.left, left);
                const x1 = Math.min(extent[1] + this._padding.right, right);
                if (x1 > x0)
                    rects.push([x0, top, x1 - x0, pillHeight]);
            }
        }
        if (this._style === 'islands' && !holdIslandGeometry) {
            this._lastIslandRects = rects.map(rect => [...rect]);
        }
        else if (this._style === 'islands' && this._lastIslandRects.length === 0 && rects.length > 0) {
            this._lastIslandRects = rects.map(rect => [...rect]);
        }
        const key = `${x},${y},${width},${height},${rects.flat().join(',')}`;
        if (key !== this._lastKey) {
            this._lastKey = key;
            glass.set_position(x, y);
            glass.set_size(width, height + SHADOW_ROOM);
            glass.setResolution(width, height + SHADOW_ROOM);
            const p = SHADER_PADDING;
            if (this._style === 'pill') {
                const [rx, ry, rw, rh] = rects[0];
                glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
            }
            else {
                const regions = rects.map(([rx, ry, rw, rh]) => ({
                    x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
                }));
                glass.setGlassRegions(regions);
                glass.setGlassGeometry(0, 0, width, height);
            }
            this._text.invalidate();
        }
        glass.syncSources();
    }

    _remove() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._text.clear();
        const glass = this._glass;
        this._glass = null;
        this._disconnectBoxSignals();
        this._disconnectContainerSignals();
        if (glass) {
            glass.cleanup();
            if (isActorValid(glass))
                glass.destroy();
            Main.panel.remove_style_class_name('liquid-glass-transparent');
        }
        if (this._panelStyleId)
            Main.panel.disconnect(this._panelStyleId);
        this._panelStyleId = 0;
        for (const [actor, style] of this._savedStyles)
            if (isActorValid(actor))
                actor.set_style(style);
        for (const [actor, style] of this._childrenStyles)
            if (isActorValid(actor))
                actor.set_style(style);
        this._savedStyles = [];
        this._childrenStyles = [];
        this._lastIslandRects = [];
        this._islandGeometryHoldFrames = 0;
        this._style = 'off';
        this._applyingLayout = false;
    }

    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._remove();
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
