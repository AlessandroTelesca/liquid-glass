// The colours icon-style.frag draws a style map in, per look. Pure, so that
// the contact sheet can show the same.
function mix(a, b, t) {
    return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
}

/**
 * @param tint The accent or chosen colour, 0 to 1 a channel.
 * @param strength How much of the tint the plates take, 0 (frosted white) to 1.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 * @param lightSymbol A white symbol instead of a dark one.
 */
export function iconStyleColors(mode, tint, strength, symbolOpacity, lightSymbol) {
    const white = [1, 1, 1], black = [0, 0, 0];
    const symbol = [...(lightSymbol ? white : black), symbolOpacity];
    if (mode === 'mono') {
        return { plate: [...mix(white, black, 0.1), 0.72], inner: [1, 1, 1, 0.6], rim: 0.7, symbol,
            tint: [0.62, 0.62, 0.64] };
    }
    if (mode === 'clear') {
        return { plate: [1, 1, 1, 0.3], inner: [1, 1, 1, 0.24], rim: 0.9, symbol, tint: [0.75, 0.75, 0.78] };
    }
    const plate = mix(white, tint, 0.2 + 0.8 * strength);
    return { plate: [...plate, 0.62 + 0.3 * strength], inner: [...mix(plate, white, 0.5), 0.55 + 0.3 * strength], rim: 0.7,
        symbol, tint: [tint[0], tint[1], tint[2]] };
}
