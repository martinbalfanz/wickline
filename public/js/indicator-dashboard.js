// Compact chart-legend badges for custom user scripts. Content is escaped
// even though the worker result sanitizer already validates each field.
export function entryDashboardChanged(entry, panel) {
  const previous = JSON.stringify(entry.dashboard || null);
  entry.dashboard = panel || null;
  return previous !== JSON.stringify(entry.dashboard);
}

export function dashboardHtml(panel, esc) {
  if (!panel) return '';
  return '<span class="indicator-dashboard">'
    + '<span class="indicator-status" data-tone="' + esc(panel.tone) + '">' + esc(panel.status) + '</span>'
    + panel.metrics.map(m => '<span class="indicator-metric" data-tone="' + esc(m.tone) + '">'
      + '<small>' + esc(m.label) + '</small><b>' + esc(m.value) + '</b></span>').join('')
    + '</span>';
}
