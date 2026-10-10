// The colours icon-style.frag draws a style map in, per look, after macOS 26's
// tinted, white and clear icons. Pure, so that the contact sheet can show the same.
// The glass under tinted and mono icons: dark, and opaque so that what is behind the dock does not show through.
const DARK = [0.11, 0.12, 0.14];
const WHITE = [1, 1, 1];

function mix(a, b, t) {
    return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
}

/**
 * @param tint The accent or chosen colour, 0 to 1 a channel.
 * @param strength How much of the tint the outer plate takes, 0 (the dark glass alone) to 1.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 */
export function iconStyleColors(mode, tint, strength, symbolOpacity) {
    if (mode === 'clear') {
        // Barely frosted, so that the white symbol stands apart from the plates.
        return { plate: [1, 1, 1, 0.08], inner: [1, 1, 1, 0.1], symbol: [1, 1, 1, symbolOpacity],
            symbolInner: [1, 1, 1, symbolOpacity], rim: 0.8, tint: [0.75, 0.75, 0.78] };
    }
    if (mode === 'mono') {
        return { plate: [...DARK, 1], inner: [0.72, 0.74, 0.78, 0.92], symbol: [0.93, 0.94, 0.96, symbolOpacity],
            symbolInner: [...DARK, symbolOpacity], rim: 0.55, tint: [0.62, 0.62, 0.64] };
    }
    const t = tint.slice(0, 3);
    // On a plate in a light tint the symbol is dark, as the cut-outs in it would be; on a dark one, light.
    const light = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2] > 0.2;
    return { plate: [...mix(DARK, t.map(v => v * 0.55), strength), 1], inner: [...mix(t, WHITE, 0.05), 0.92],
        symbol: [...mix(t, WHITE, 0.15), symbolOpacity],
        symbolInner: [...(light ? mix(DARK, t, 0.15) : mix(t, WHITE, 0.75)), symbolOpacity], rim: 0.55,
        tint: [t[0], t[1], t[2]] };
}

/** The shader's uniforms for `colors`, by name. */
export function iconStyleUniforms(colors) {
    const out = [['rim_a', colors.rim]];
    for (const name of ['plate', 'inner', 'symbol', 'symbolInner']) {
        const uniform = name === 'symbolInner' ? 'symbol_inner' : name;
        colors[name].forEach((v, i) => out.push([`${uniform}_${'rgba'[i]}`, v]));
    }
    colors.tint.forEach((v, i) => out.push([`tint_${'rgb'[i]}`, v]));
    return out;
}
