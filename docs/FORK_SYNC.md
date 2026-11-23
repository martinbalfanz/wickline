# Keeping the Wickline fork up to date

Our additions are **optional general-purpose script APIs** (`compareClose`, `dashboard`,
and `plot(..., { legend: false })`) plus improved latest-candle positioning.
There is no user-specific indicator bundled in the repository.

## One command

From a clean working tree, run:

```bash
bash scripts/sync-upstream.sh
```

This adds the original repository as the `upstream` remote if necessary, fetches
its latest `main`, updates local `main` with your fork, creates
`sync/upstream-<sha>`, merges upstream, runs `npm test`, and pushes the
**review branch**. It does not force-push or automatically merge unreviewed code.

Review the branch on GitHub, run `npm run test:e2e` when possible, and merge
only after checks pass. Future syncs use ordinary merges; upstream commits
remain ancestors of our fork.

## Where custom functionality lives

- `public/js/benchmark-data.js`: hidden, shared feeds and chart-facing bridge.
- `public/js/indicator-extensions.js`: optional worker API and strict result validation.
- `public/js/indicator-dashboard.js` and `public/css/indicator-dashboard.css`:
  indicator status UI, separate from the upstream stylesheet.
- `public/js/viewport.js`: latest-candle viewport reset and zoom.
- Upstream files have small integration hooks only (chart-view, worker, sanitizer,
  editor, HTML, and test scripts). Keep new behavior in modules first.

A merge conflict is possible if upstream edits one of these integration points.
Do not resolve conflicts by replacing entire upstream files with old fork copies:
you may silently undo their new security checks, timeframe handling or features.
Resolve just the changed lines; prefer their new interfaces and keep the sanitizer
whitelisting all new result fields. CI covers these extension contracts.
