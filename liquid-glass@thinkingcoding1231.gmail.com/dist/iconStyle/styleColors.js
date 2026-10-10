// The colours icon-style.frag draws a style map in, per look. Pure, so that
// the contact sheet can show the same.
function mix(a, b, t) {
    return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
}

/**
 * @param tint The accent or chosen colour, 0 to 1 a channel.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 * @param lightSymbol A white symbol instead of a dark one.
 */
export function iconStyleColors(mode, tint, symbolOpacity, lightSymbol) {
    const white = [1, 1, 1], black = [0, 0, 0];
    const symbol = [...(lightSymbol ? white : black), symbolOpacity];
    if (mode === 'mono') {
        return { plate: [...mix(white, black, 0.06), 0.32], inner: [1, 1, 1, 0.22], rim: 0.6, symbol,
            tint: [0.62, 0.62, 0.64] };
    }
    if (mode === 'clear') {
        return { plate: [1, 1, 1, 0.12], inner: [1, 1, 1, 0.1], rim: 0.75, symbol, tint: [0.75, 0.75, 0.78] };
    }
    return { plate: [...mix(tint, white, 0.12), 0.48], inner: [...mix(tint, white, 0.45), 0.32], rim: 0.6, symbol,
        tint: [tint[0], tint[1], tint[2]] };
}
