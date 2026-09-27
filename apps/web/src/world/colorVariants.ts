/** Deterministic per-table color variation: every table in a file shared one flat color before,
 * which — combined with several bodies sitting close together on screen — made it hard to tell
 * which label belonged to which sphere without hovering each one. Varies hue and lightness around
 * the same base color (same family per database file, still visually distinct table to table),
 * seeded by the table's own name so it's stable across re-renders and reloads, not random each time. */

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r0, g0, b0] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const toHex = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r0)}${toHex(g0)}${toHex(b0)}`;
}

/** Same base color's hue/lightness family, shifted a bounded, name-seeded amount so adjacent tables
 * read as distinct at a glance without losing the "these all belong to the same file" grouping. */
export function tableColor(baseHex: string, name: string): string {
  const [h, s, l] = hexToHsl(baseHex);
  const hash = hashString(name);
  const hueShift = ((hash % 1000) / 1000 - 0.5) * 40; // ±20°
  const lightShift = (((Math.floor(hash / 1000)) % 1000) / 1000 - 0.5) * 0.22; // ±11%
  return hslToHex((h + hueShift + 360) % 360, s, Math.min(0.8, Math.max(0.32, l + lightShift)));
}
