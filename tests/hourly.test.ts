// H1 以上の時間足の過去は、1 分足を 1 時間足にまとめて持ち、そこからまとめ直す（src/main.ts の withHistory）。
// 1 分足から直接まとめたのと同じ足になることを、夏時間の切り替えをまたぐ 6 か月の乱数の値動きで確かめる。

import { describe, expect, it } from 'vitest';
import { aggregate, type Bar, type Timeframe } from '../src/core/candles';
import { DEFAULT_SERVER_RULE } from '../src/core/time';

function m1(seed: number): Bar[] {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: Bar[] = [];
  let p = 150;
  for (let t = Date.UTC(2026, 1, 1); t < Date.UTC(2026, 7, 1); t += 60_000) {
    const d = new Date(t).getUTCDay();
    if (d === 6 || (d === 0 && new Date(t).getUTCHours() < 21) || r() < 0.05) continue; // 週末と、ところどころ足の無い分
    const o = p;
    p = Math.round((p + (r() - 0.5) * 0.04) * 1000) / 1000;
    out.push({ t, o, h: Math.max(o, p) + 0.005, l: Math.min(o, p) - 0.005, c: p });
  }
  return out;
}

describe('1 時間足からまとめ直しても、1 分足から直接まとめたのと同じ', () => {
  const bars = m1(7);
  const hourly = aggregate(bars, 'H1', DEFAULT_SERVER_RULE);
  for (const tf of ['H1', 'H4', 'D1', 'W1', 'MN'] as Timeframe[]) {
    it(tf, () => {
      expect(aggregate(hourly, tf, DEFAULT_SERVER_RULE)).toEqual(aggregate(bars, tf, DEFAULT_SERVER_RULE));
    });
  }
  it('月ごとに分けて 1 時間足にしてからつないでも同じ（1 時間足は UTC の月をまたがない）', () => {
    const byMonth: Bar[] = [];
    for (let m = 1; m < 7; m++) {
      const lo = Date.UTC(2026, m, 1);
      const hi = Date.UTC(2026, m + 1, 1);
      byMonth.push(...aggregate(bars.filter((b) => b.t >= lo && b.t < hi), 'H1', DEFAULT_SERVER_RULE));
    }
    expect(byMonth).toEqual(hourly);
  });
});
