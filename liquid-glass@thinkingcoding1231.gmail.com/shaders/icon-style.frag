// An icon redrawn from its style map (src/iconStyle/styleMap.ts) as glass
// plates under a one-colour symbol. A Cogl fragment snippet for
// src/iconStyle/iconEffect.ts; the contact sheet (tools/icon-sheet) runs it in
// WebGL too.
uniform sampler2D cogl_sampler0; // The icon as drawn, for the launch animation
uniform sampler2D cogl_sampler1; // The style map

// The icon's square in layer 0's texture coordinates.
uniform float box_x0;
uniform float box_y0;
uniform float box_x1;
uniform float box_y1;
// Map px per screen px, for the width of anti-aliased edges.
uniform float map_px;
// 1 while a clone draws the icon (the launch animation): its colours only.
uniform float clone;
uniform float plate_r;
uniform float plate_g;
uniform float plate_b;
uniform float plate_a;
uniform float inner_r;
uniform float inner_g;
uniform float inner_b;
uniform float inner_a;
uniform float rim_a;
uniform float symbol_r;
uniform float symbol_g;
uniform float symbol_b;
uniform float symbol_a;
uniform float tint_r;
uniform float tint_g;
uniform float tint_b;
uniform float opacity;

const float MAP_SIZE = 256.0;
const float MAP_RANGE = 16.0;
// The lit rim's width, map px.
const float RIM = 7.0;

float field(float v) {
    return (0.5 - v) * 2.0 * MAP_RANGE;
}

vec4 over(vec4 dst, vec4 src) {
    return src + dst * (1.0 - src.a);
}

// A plate whose outline is at distance d (map px) with outward normal n: a
// sheet of colour with a rim lit from the top left and shaded at the bottom right.
vec4 plate(float d, vec2 n, vec3 rgb, float alpha) {
    float cover = clamp(0.5 - d / max(map_px, 0.5), 0.0, 1.0);
    float rim = 1.0 - clamp(-d / RIM, 0.0, 1.0);
    rim *= rim;
    float facing = dot(n, normalize(vec2(-0.55, -0.83)));
    float light = rim_a * rim * (0.3 + 0.7 * max(facing, 0.0));
    float shade = rim_a * rim * 0.45 * max(-facing, 0.0);
    vec4 c = vec4(rgb * alpha, alpha);
    c = over(c, vec4(vec3(light), light));
    c.rgb *= 1.0 - shade;
    return c * cover;
}

vec2 normalAt(vec2 uv, int channel) {
    float t = 1.0 / MAP_SIZE;
    vec4 l = texture2D(cogl_sampler1, uv - vec2(t, 0.0));
    vec4 r = texture2D(cogl_sampler1, uv + vec2(t, 0.0));
    vec4 u = texture2D(cogl_sampler1, uv - vec2(0.0, t));
    vec4 b = texture2D(cogl_sampler1, uv + vec2(0.0, t));
    vec2 g;
    if (channel == 0) g = vec2(l.r - r.r, u.r - b.r);
    else if (channel == 1) g = vec2(l.g - r.g, u.g - b.g);
    else g = vec2(l.b - r.b, u.b - b.b);
    float len = length(g);
    return len > 1e-5 ? g / len : vec2(0.0);
}

// No early return: Cogl may add its own steps after this code.
void main() {
    vec2 st = cogl_tex_coord_in[0].st;
    vec4 c = vec4(0.0);
    vec2 uv = (st - vec2(box_x0, box_y0)) / vec2(box_x1 - box_x0, box_y1 - box_y0);
    if (clone > 0.5) {
        // Lightness over the tint, from its dark to its light side.
        vec4 icon = texture2D(cogl_sampler0, st);
        vec3 rgb = icon.a > 0.0 ? icon.rgb / icon.a : vec3(0.0);
        float l = smoothstep(0.08, 0.92, dot(rgb, vec3(0.2126, 0.7152, 0.0722)));
        vec3 tint = vec3(tint_r, tint_g, tint_b);
        c = vec4(mix(tint * 0.3, mix(tint, vec3(1.0), 0.7), l) * icon.a, icon.a);
    } else if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
        vec4 m = texture2D(cogl_sampler1, uv);
        c = plate(field(m.r), normalAt(uv, 0), vec3(plate_r, plate_g, plate_b), plate_a);
        vec3 inner = vec3(inner_r, inner_g, inner_b);
        if (m.g > 0.0) c = over(c, plate(field(m.g), normalAt(uv, 1), inner, inner_a));
        if (m.b > 0.0) c = over(c, plate(field(m.b), normalAt(uv, 2), inner, inner_a));
        c = over(c, vec4(symbol_r, symbol_g, symbol_b, 1.0) * (symbol_a * m.a));
    }
    cogl_color_out = c * opacity;
}
