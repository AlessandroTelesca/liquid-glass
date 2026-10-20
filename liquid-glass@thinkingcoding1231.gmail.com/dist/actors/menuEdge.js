import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

/**
 * The shell keeps a menu `-arrow-rise` px inside its monitor's work area, but the glass reaches `overhang()` px
 * [left, right] past the menu's sides and is drawn only on that monitor, so at a screen edge its side would be cut.
 * This moves the menu so that the glass keeps the shell's distance instead. Returns the function that undoes it.
 */
export function keepGlassInWorkArea(actor, overhang) {
    if (!(actor instanceof BoxPointer.BoxPointer))
        return () => { };
    const pointer = actor;
    const reposition = pointer._reposition;
    pointer._reposition = function (box) {
        reposition.call(this, box);
        const source = this._sourceActor;
        const parent = this.get_parent();
        if (!source || !parent || (this._arrowSide !== St.Side.TOP && this._arrowSide !== St.Side.BOTTOM))
            return;
        const layout = Main.layoutManager;
        const area = layout.getWorkAreaForMonitor(layout.findIndexForActor(source));
        const rise = this.get_theme_node().get_length('-arrow-rise');
        const [before, after] = overhang();
        const x = box.x1 + parent.get_transformed_position()[0];
        const min = area.x + rise + Math.max(before, 0);
        const max = area.x + area.width - rise - Math.max(after, 0) - box.get_width();
        // Too wide to keep the glass inside: the shell's placement is the best there is.
        if (max < min)
            return;
        const shift = Math.round(Math.min(Math.max(x, min), max) - x);
        if (shift !== 0)
            box.set_origin(box.x1 + shift, box.y1);
    };
    pointer.queue_relayout();
    return () => {
        // Drops the instance's own method, so the prototype's is used again.
        Reflect.deleteProperty(pointer, '_reposition');
        pointer.queue_relayout();
    };
}
