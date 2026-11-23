// CSV files for spreadsheets (the Strategy Tester's trade list).
//
// Every field is quoted. Text that a spreadsheet would run as a formula (it starts with =, +, -, @,
// a tab or a carriage return) gets a ' in front so it stays text: trade signals and exit reasons come
// from scripts, which anyone can publish. Numbers stay numbers.

/** One CSV field. Numbers are written as numbers (NaN and Infinity as empty fields), anything else as text. */
export function csvCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? `"${v}"` : '""';
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvRow = (cells) => cells.map(csvCell).join(',');

/** The closed trades of a backtest report as CSV. `times` maps bar indexes to Unix seconds. */
export function tradesCsv(trades, times) {
  const iso = (x) => (Number.isFinite(x) ? new Date(x * 1000).toISOString().replace('.000Z', '') : '');
  const fixed = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);
  const head = ['#', 'type', 'signal', 'entry_time', 'entry_price', 'exit_reason', 'exit_time', 'exit_price', 'qty', 'pnl', 'pnl_pct', 'runup', 'drawdown', 'bars'];
  const rows = trades.map((tr, k) => [k + 1, tr.side, tr.id, iso(times[tr.entryIndex]), tr.entryPrice, tr.reason,
    iso(times[tr.exitIndex]), tr.exitPrice, tr.qty, fixed(tr.pnl), fixed(tr.pnlPct), fixed(tr.runup), fixed(tr.drawdown), tr.bars]);
  return [head, ...rows].map(csvRow).join('\n');
}
