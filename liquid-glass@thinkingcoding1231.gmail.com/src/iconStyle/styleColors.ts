// The colours icon-style.frag draws a style map in, per look. Pure, so that
// the contact sheet can show the same.

export type IconStyleMode = 'tinted' | 'mono' | 'clear';

export interface IconStyleColors {
  plate: [number, number, number, number];
  inner: [number, number, number, number];
  rim: number;
  symbol: [number, number, number, number];
  // The launch animation's colour, which the icon's lightness runs across.
  tint: [number, number, number];
}

function mix(a: number[], b: number[], t: number): [number, number, number] {
  return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t) as [number, number, number];
}

/**
 * @param tint The accent or chosen colour, 0 to 1 a channel.
 * @param strength How much of the tint the plates take, 0 (frosted white) to 1.
 * @param symbolOpacity How strongly the symbol shows, 0 to 1.
 * @param lightSymbol A white symbol instead of a dark one.
 */
export function iconStyleColors(mode: IconStyleMode, tint: number[], strength: number, symbolOpacity: number,
  lightSymbol: boolean): IconStyleColors {
  const white = [1, 1, 1], black = [0, 0, 0];
  const symbol: [number, number, number, number] = [...(lightSymbol ? white : black), symbolOpacity] as any;
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
