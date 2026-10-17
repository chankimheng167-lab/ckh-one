/**
 * Theme Studio tokens. A tenant stores overrides for these keys; the web app
 * maps each one to a CSS custom property, so every screen follows the
 * company's branding without per-screen code.
 */
export const THEME_TOKENS = {
  primary: { cssVar: '--ckh-primary', kind: 'color', default: '#1f6feb' },
  primaryText: { cssVar: '--ckh-primary-text', kind: 'color', default: '#ffffff' },
  background: { cssVar: '--ckh-bg', kind: 'color', default: '#f6f8fa' },
  surface: { cssVar: '--ckh-surface', kind: 'color', default: '#ffffff' },
  text: { cssVar: '--ckh-text', kind: 'color', default: '#1f2328' },
  mutedText: { cssVar: '--ckh-muted', kind: 'color', default: '#59636e' },
  border: { cssVar: '--ckh-border', kind: 'color', default: '#d1d9e0' },
  success: { cssVar: '--ckh-success', kind: 'color', default: '#1a7f37' },
  warning: { cssVar: '--ckh-warning', kind: 'color', default: '#9a6700' },
  danger: { cssVar: '--ckh-danger', kind: 'color', default: '#cf222e' },
  radius: { cssVar: '--ckh-radius', kind: 'length', default: '8px' },
  fontFamily: { cssVar: '--ckh-font', kind: 'font', default: "'Inter', 'Noto Sans Khmer', system-ui, sans-serif" },
} as const;

export type ThemeTokenKey = keyof typeof THEME_TOKENS;
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>;

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LENGTH = /^(?:0|\d{1,2}(?:\.\d+)?(?:px|rem))$/;
// Font stacks: names, quotes, commas, spaces and hyphens only — no url() or expressions.
const FONT = /^[A-Za-z0-9 ,'"\-]{1,200}$/;

/** Returns a list of problems; empty means the tokens are safe to store and inject as CSS. */
export function validateThemeTokens(tokens: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(tokens)) {
    const def = (THEME_TOKENS as Record<string, { kind: string }>)[k];
    if (!def) { errors.push(`Unknown theme token "${k}"`); continue; }
    if (typeof v !== 'string') { errors.push(`${k} must be a string`); continue; }
    const ok = def.kind === 'color' ? COLOR.test(v) : def.kind === 'length' ? LENGTH.test(v) : FONT.test(v);
    if (!ok) errors.push(`${k} has an invalid ${def.kind} value`);
  }
  return errors;
}

/** Full token set with defaults filled in, as CSS variable → value. */
export function themeCssVariables(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, def] of Object.entries(THEME_TOKENS)) out[def.cssVar] = tokens[k as ThemeTokenKey] ?? def.default;
  return out;
}

/** Relative luminance contrast ratio (WCAG), used to warn about unreadable colour pairs. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
