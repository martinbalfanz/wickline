// Position the time scale by its live edge, not a logical bar index computed
// from a series length. Other series and late resizes may change those indices.
export const DEFAULT_VISIBLE_BARS = 150;
export const DEFAULT_RIGHT_PADDING = 10;

export function focusLatestBars(timeScale) {
  const width = timeScale.width();
  if (Number.isFinite(width) && width > 0) {
    // Aim for ~150 candles on every new symbol/timeframe, independent of
    // whatever zoom was used for the previous one.
    timeScale.applyOptions({ barSpacing: Math.max(2, Math.min(18, width / DEFAULT_VISIBLE_BARS)) });
  }
  // Non-animated: the latest data should already be visible when loading ends.
  // Unlike setVisibleLogicalRange({from: n - 150, to: n + 10}), this is
  // independent of the number of data points on the time scale.
  timeScale.scrollToPosition(DEFAULT_RIGHT_PADDING, false);
}
