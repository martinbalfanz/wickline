import { locale } from './i18n.js';

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`wickline.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`wickline.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const numberFormats = new Map();
/**
 * A cached Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max })
 * (undefined: the default), in the UI language's locale (en-US writes 1,234.56, es-ES 1.234,56).
 * Same output as v.toLocaleString(locale, {...}), which builds a new formatter on every
 * call (~15 µs each).
 */
export function numberFormat(min, max) {
  const key = `${min}|${max}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    if (numberFormats.size >= 64) numberFormats.clear();
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(v, decimals) {
  if (v == null || !Number.isFinite(v)) return '—';
  return numberFormat(decimals, decimals).format(v);
}

/** True when the UI language writes decimals with a comma (es, pt-BR). */
export const decimalComma = numberFormat(1, 1).format(1.5).includes(',');

/**
 * v.toFixed(d) with the UI language's decimal mark and no grouping: for display only (inputs,
 * files and URLs keep toFixed's dot).
 */
export function fixed(v, d) {
  const s = v.toFixed(d);
  return decimalComma ? s.replace('.', ',') : s;
}

/** Sensible decimals when the instrument's tick size is unknown. */
export function smartDecimals(p) {
  const a = Math.abs(p);
  if (a >= 10) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 8;
}

export function formatVolume(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return fixed(v / 1e12, 2) + 'T';
  if (a >= 1e9) return fixed(v / 1e9, 2) + 'B';
  if (a >= 1e6) return fixed(v / 1e6, 2) + 'M';
  if (a >= 1e3) return fixed(v / 1e3, 2) + 'K';
  return fixed(v, a < 10 ? 2 : 0);
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** '#rrggbb' (or '#rgb') plus an opacity -> 'rgba(r, g, b, a)'. */
export function withAlpha(hex, a) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
