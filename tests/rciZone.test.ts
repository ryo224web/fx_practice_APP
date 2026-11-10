import { describe, expect, it } from 'vitest';
import { rciZoneSpans } from '../src/chart/rciZone';
import { rciAt } from '../src/indicators/calc';

describe('RCI の 0 付近を背景で知らせる', () => {
  const M = 15 * 60_000;
  // 上げ → 横ばい → 上げ。横ばいの所で RCI が 0 付近になる
  const closes = Float64Array.from([...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 130 + (i % 2 ? 0.3 : -0.3)), ...Array.from({ length: 30 }, (_, i) => 131 + i)]);
  const times = Array.from({ length: closes.length }, (_, i) => i * M);
  const cfg = { enabled: true, tf: 'M15', period: 9, level: 20 };

  it('RCI が ±level の内側の足だけ塗り、続いた足は 1 つにまとめる', () => {
    const k = closes.length - 1;
    const spans = rciZoneSpans(times, closes, k, closes[k], times[k] + M, M, cfg, null);
    for (let j = 8; j < k; j++) {
      const inside = Math.abs(rciAt(closes, j, 9)) <= 20;
      const covered = spans.some((s) => s.t0 <= times[j] && times[j] < s.t1);
      expect(covered).toBe(inside);
    }
    for (let q = 1; q < spans.length; q++) expect(spans[q].t0).toBeGreaterThan(spans[q - 1].t1);
  });

  it('今の足は今の終値で計算し、今の時刻より先は塗らない', () => {
    const k = 45; // 横ばいの途中
    const now = times[k] + 5 * 60_000;
    const spans = rciZoneSpans(times, closes, k, closes[k], now, M, cfg, null);
    const last = spans[spans.length - 1];
    expect(last.t1).toBeLessThanOrEqual(now);
    // 今の終値を大きく変えると、今の足の判定が変わる（先の終値 closes[k] は使っていない）
    const r = rciAt(closes, k, 9, 1e6);
    const spans2 = rciZoneSpans(times, closes, k, 1e6, now, M, cfg, null);
    const covered = spans2.some((s) => s.t0 <= times[k] && times[k] < s.t1);
    expect(covered).toBe(Math.abs(r) <= 20);
  });
});
