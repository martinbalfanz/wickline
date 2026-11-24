// The watchlist's order and sections. It is saved as one array of strings: symbols ("YAHOO:AAPL")
// and section headings ("§Crypto"); a section holds the symbols below it, up to the next heading.
// Lists saved before sections existed are plain arrays of symbols, so they load unchanged.
// Pure functions, unit-tested in test/watchlist.test.mjs; quote-list.js draws the list.

const MARK = '§';
const MAX_NAME = 40;

export const isSection = (entry) => typeof entry === 'string' && entry.startsWith(MARK);
export const sectionName = (entry) => entry.slice(MARK.length);
export const sectionOf = (name) => MARK + name;
/** The symbols alone, in order. */
export const symbolsOf = (list) => list.filter((e) => !isSection(e));

/** A saved list made safe: strings only, no repeats, no blank section names. Not an array: null. */
export function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const entry = isSection(raw) ? sectionOf(sectionName(raw).trim().slice(0, MAX_NAME)) : raw.trim();
    if (!entry || entry === MARK || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** A section name that isn't taken yet ("New section", then "New section 2"...). `except`: a name being renamed. */
export function uniqueName(list, name, except = null) {
  const base = String(name ?? '').trim().slice(0, MAX_NAME) || 'Section';
  const taken = new Set(list.filter(isSection).map(sectionName).filter((n) => n !== except));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Adds an empty section at the end: { list, name } (the name made unique). */
export function addSection(list, name) {
  const unique = uniqueName(list, name);
  return { list: [...list, sectionOf(unique)], name: unique };
}

/** Renames a section: { list, name }. A blank new name keeps the old one. */
export function renameSection(list, from, to) {
  const unique = String(to ?? '').trim() ? uniqueName(list, to, from) : from;
  return { list: list.map((e) => (e === sectionOf(from) ? sectionOf(unique) : e)), name: unique };
}

/** Removes a section's heading; its symbols join the section above (or the top of the list). */
export const removeSection = (list, name) => list.filter((e) => e !== sectionOf(name));

/** What dragging the entry at index i moves: [start, count] (a symbol alone, a section with its symbols). */
export function blockAt(list, i) {
  if (!isSection(list[i])) return [i, 1];
  let j = i + 1;
  while (j < list.length && !isSection(list[j])) j++;
  return [i, j - i];
}

/**
 * Moves the entry at index `from` so that it lands just before the entry now at index `to`
 * (list.length: at the end). A section moves with its symbols, and only between sections, so it
 * never splits another one or takes the ungrouped symbols at the top. Returns a new list.
 */
export function moveEntry(list, from, to) {
  if (from < 0 || from >= list.length) return list;
  const [start, count] = blockAt(list, from);
  const block = list.slice(start, start + count);
  const rest = [...list.slice(0, start), ...list.slice(start + count)];
  let at = Math.max(0, Math.min(to, list.length));
  if (at > start + count) at -= count;
  else if (at > start) at = start; // dropped onto itself
  if (isSection(list[start])) while (at < rest.length && !isSection(rest[at])) at++;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/** The section each symbol is in ('' above the first section): Map symbol → section name. */
export function sectionsBySymbol(list) {
  const out = new Map();
  let current = '';
  for (const e of list) {
    if (isSection(e)) current = sectionName(e);
    else out.set(e, current);
  }
  return out;
}
