// The colours icon-style.frag draws a style map in, per look, after macOS 26's
// tinted, white and clear icons. Pure, so that the contact sheet and the
// preferences can use it too.
const ALL = ['dark', 'light', 'mono', 'clear'];
export const ICON_TUNING = [
    { key: 'rimWidth', title: 'Rim width', looks: ALL, min: 1, max: 16, value: 7 },
    { key: 'rimBase', title: 'Rim light away from the light', looks: ALL, min: 0, max: 1, value: 0.2 },
    { key: 'sheen', title: 'Sheen (top lighter than bottom)', looks: ALL, min: 0, max: 0.5, value: 0.1 },
    { key: 'darkGlass', title: 'Glass lightness', looks: ['dark'], min: 0, max: 0.6, value: 0.12 },
    { key: 'darkGlassAlpha', title: 'Glass opacity', looks: ['dark'], min: 0, max: 1, value: 1 },
    { key: 'darkTintReach', title: 'Color in the glass at full tint strength', looks: ['dark'], min: 0, max: 1, value: 0.55 },
    { key: 'darkInnerWhite', title: 'Plates: white mixed into the color', looks: ['dark'], min: 0, max: 1, value: 0.05 },
    { key: 'darkInnerAlpha', title: 'Plates: opacity', looks: ['dark'], min: 0, max: 1, value: 0.92 },
    { key: 'darkSymbolWhite', title: 'Symbol: white mixed into the color', looks: ['dark'], min: 0, max: 1, value: 0.15 },
    { key: 'darkLightTint', title: 'Colors lighter than this get a dark symbol on plates', looks: ['dark'], min: 0, max: 1,
        value: 0.2 },
    { key: 'darkSymbolOnLight', title: 'Dark symbol on plates: color mixed into the glass', looks: ['dark'], min: 0, max: 1,
        value: 0.15 },
    { key: 'darkSymbolOnDark', title: 'Light symbol on plates: white mixed into the color', looks: ['dark'], min: 0, max: 1,
        value: 0.75 },
    { key: 'darkRim', title: 'Rim brightness', looks: ['dark'], min: 0, max: 1, value: 0.55 },
    { key: 'lightGlassBlack', title: 'Glass: black mixed into the color', looks: ['light'], min: 0, max: 1, value: 0.25 },
    { key: 'lightGlassAlpha', title: 'Glass opacity', looks: ['light'], min: 0, max: 1, value: 1 },
    { key: 'lightInnerAlpha', title: 'Plates: white over the glass', looks: ['light'], min: 0, max: 1, value: 0.22 },
    { key: 'lightSymbolTint', title: 'Symbol: color mixed into white', looks: ['light'], min: 0, max: 1, value: 0.08 },
    { key: 'lightRim', title: 'Rim brightness', looks: ['light'], min: 0, max: 1, value: 0.6 },
    { key: 'monoGlass', title: 'Glass lightness', looks: ['mono'], min: 0, max: 0.6, value: 0.12 },
    { key: 'monoInner', title: 'Plates: lightness', looks: ['mono'], min: 0, max: 1, value: 0.74 },
    { key: 'monoInnerAlpha', title: 'Plates: opacity', looks: ['mono'], min: 0, max: 1, value: 0.92 },
    { key: 'monoSymbol', title: 'Symbol: lightness', looks: ['mono'], min: 0, max: 1, value: 0.94 },
    { key: 'monoRim', title: 'Rim brightness', looks: ['mono'], min: 0, max: 1, value: 0.55 },
    { key: 'clearGlassAlpha', title: 'Glass: white over the backdrop', looks: ['clear'], min: 0, max: 1, value: 0.08 },
    { key: 'clearInnerAlpha', title: 'Plates: white over the glass', looks: ['clear'], min: 0, max: 1, value: 0.1 },
    { key: 'clearRim', title: 'Rim brightness', looks: ['clear'], min: 0, max: 1, value: 0.8 },
];
const WHITE = [1, 1, 1];

function mix(a, b, t) {
    return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
}

// A grey a little cooler than neutral.
function glass(lightness) {
    return [lightness - 0.01, lightness, lightness + 0.02].map(v => Math.min(Math.max(v, 0), 1));
}

/**
 * @param tint The accent or chosen colour, 0 to 1 a channel.
 * @param strength How much of the tint the outer plate of a dark tinted icon takes, 0 (the dark glass alone) to 1.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 * @param tuning Values that replace ICON_TUNING's, by key.
 */
export function iconStyleColors(mode, tint, strength, symbolOpacity, variant = 'dark', tuning = {}) {
    const v = (key) => tuning[key] ?? ICON_TUNING.find(p => p.key === key).value;
    const shared = { rimWidth: v('rimWidth'), rimBase: v('rimBase'), sheen: v('sheen') };
    if (mode === 'clear') {
        // Barely frosted, so that the white symbol stands apart from the plates.
        return { ...shared, plate: [1, 1, 1, v('clearGlassAlpha')], inner: [1, 1, 1, v('clearInnerAlpha')],
            symbol: [1, 1, 1, symbolOpacity], symbolInner: [1, 1, 1, symbolOpacity], rim: v('clearRim'), tint: [0.75, 0.75, 0.78] };
    }
    if (mode === 'mono') {
        return { ...shared, plate: [...glass(v('monoGlass')), 1], inner: [...glass(v('monoInner')), v('monoInnerAlpha')],
            symbol: [...glass(v('monoSymbol')), symbolOpacity], symbolInner: [...glass(v('monoGlass')), symbolOpacity],
            rim: v('monoRim'), tint: [0.62, 0.62, 0.64] };
    }
    const t = tint.slice(0, 3);
    if (variant === 'light') {
        const symbol = [...mix(WHITE, t, v('lightSymbolTint')), symbolOpacity];
        return { ...shared, plate: [...mix(t, [0, 0, 0], v('lightGlassBlack')), v('lightGlassAlpha')],
            inner: [1, 1, 1, v('lightInnerAlpha')], symbol, symbolInner: symbol, rim: v('lightRim'), tint: [t[0], t[1], t[2]] };
    }
    const dark = glass(v('darkGlass'));
    // On a plate in a light colour the symbol is dark, as the cut-outs in it would be; on a dark one, light.
    const light = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2] > v('darkLightTint');
    return { ...shared, plate: [...mix(dark, t.map(c => c * v('darkTintReach')), strength), v('darkGlassAlpha')],
        inner: [...mix(t, WHITE, v('darkInnerWhite')), v('darkInnerAlpha')],
        symbol: [...mix(t, WHITE, v('darkSymbolWhite')), symbolOpacity],
        symbolInner: [...(light ? mix(dark, t, v('darkSymbolOnLight')) : mix(t, WHITE, v('darkSymbolOnDark'))), symbolOpacity],
        rim: v('darkRim'), tint: [t[0], t[1], t[2]] };
}

/** The shader's uniforms for `colors`, by name. */
export function iconStyleUniforms(colors) {
    const out = [['rim_a', colors.rim], ['rim_width', colors.rimWidth], ['rim_base', colors.rimBase],
        ['sheen', colors.sheen]];
    for (const name of ['plate', 'inner', 'symbol', 'symbolInner']) {
        const uniform = name === 'symbolInner' ? 'symbol_inner' : name;
        colors[name].forEach((c, i) => out.push([`${uniform}_${'rgba'[i]}`, c]));
    }
    colors.tint.forEach((c, i) => out.push([`tint_${'rgb'[i]}`, c]));
    return out;
}
