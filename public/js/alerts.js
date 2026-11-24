// Price alerts: checked against live prices while Wickline is open in a browser tab.

import { QuoteStream } from './datafeed.js';
import { store, uid } from './util.js';
import { t } from './i18n.js';

/** Condition id -> its label (the ids are what alerts store). */
export const CONDITIONS = { cross: t('alert.cond.cross'), up: t('alert.cond.up'), down: t('alert.cond.down') };

const TEXT = {
  cross: (v) => t('alert.text.cross', v),
  up: (v) => t('alert.text.up', v),
  down: (v) => t('alert.text.down', v),
};
/** What an alert waits for, as a sentence: "AAPL crossing up 190.50". */
export const alertText = (condition, symbol, price) => (TEXT[condition] || TEXT.cross)({ symbol, price });

export class AlertManager {
  /** evaluate: false in pop-out windows, so only the main window fires alerts. */
  constructor({ onTrigger, onChange, evaluate = true }) {
    this.items = store.get('alerts', []);
    this.onTrigger = onTrigger;
    this.onChange = onChange;
    this.evaluate = evaluate;
    this.last = new Map();
    this.stream = evaluate ? new QuoteStream((full, q) => this.check(full, q.price)) : null;
    window.addEventListener('storage', (e) => {
      if (e.key !== 'wickline.alerts') return;
      this.items = store.get('alerts', []);
      this.sync();
    });
    this.sync();
  }

  get activeCount() { return this.items.filter((a) => a.active).length; }

  add({ symbol, condition, price, message }) {
    const a = { id: uid(), symbol, condition, price: Number(price), message: message || '', active: true, created: Date.now() };
    this.items.unshift(a);
    this.save();
    return a;
  }

  remove(id) { this.items = this.items.filter((a) => a.id !== id); this.save(); }

  rearm(id) {
    const a = this.items.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, { active: true, triggeredAt: null, triggerPrice: null });
    this.last.delete(a.symbol);
    this.save();
  }

  clearTriggered() { this.items = this.items.filter((a) => a.active); this.save(); }

  save() {
    store.set('alerts', this.items);
    this.sync();
  }

  sync() {
    this.stream?.setSymbols([...new Set(this.items.filter((a) => a.active).map((a) => a.symbol))]);
    this.onChange?.(this.items);
  }

  check(full, price) {
    if (!Number.isFinite(price)) return;
    const prev = this.last.get(full);
    this.last.set(full, price);
    if (prev == null || prev === price) return;
    let fired = false;
    for (const a of this.items) {
      if (!a.active || a.symbol !== full) continue;
      const up = prev < a.price && price >= a.price;
      const down = prev > a.price && price <= a.price;
      if ((a.condition === 'cross' && (up || down)) || (a.condition === 'up' && up) || (a.condition === 'down' && down)) {
        Object.assign(a, { active: false, triggeredAt: Date.now(), triggerPrice: price });
        fired = true;
        this.onTrigger?.(a);
      }
    }
    if (fired) this.save();
  }
}

let audioCtx = null;
/** A short two-tone chime (no audio files needed). */
export function chime() {
  try {
    audioCtx ||= new AudioContext();
    const t = audioCtx.currentTime;
    [[880, 0], [1320, 0.16]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + d);
      o.stop(t + d + 0.32);
    });
  } catch { /* sound is optional */ }
}
