import { describe, expect, it } from 'vitest';
import { aggregate, type Bar } from '../src/core/candles';
import type { ServerTimeRule } from '../src/core/time';

const ny: ServerTimeRule = { kind: 'ny-close' };
const utc = (s: string) => Date.parse(s + 'Z');

function flatM1(fromUtc: number, minutes: number): Bar[] {
  return Array.from({ length: minutes }, (_, i) => {
    const p = 100 + i;
    return { t: fromUtc + i * 60_000, o: p, h: p + 0.5, l: p - 0.5, c: p + 0.1 };
  });
}

describe('aggregate', () => {
  it('日足は NY 17:00（夏は UTC 21:00）で切り替わる', () => {
    const m1 = flatM1(utc('2026-07-01T20:00:00'), 120); // UTC 20:00〜22:00
    const d1 = aggregate(m1, 'D1', ny);
    expect(d1).toHaveLength(2);
    expect(d1[1].t).toBe(utc('2026-07-01T21:00:00'));
    expect(d1[0].o).toBe(100);
    expect(d1[0].c).toBe(100 + 59 + 0.1);
    expect(d1[1].o).toBe(160);
  });

  it('冬は UTC 22:00 で切り替わる', () => {
    const d1 = aggregate(flatM1(utc('2026-01-15T21:00:00'), 120), 'D1', ny);
    expect(d1[1].t).toBe(utc('2026-01-15T22:00:00'));
  });

  it('H4 の高値・安値は中身の 1 分足の最大・最小', () => {
    const m1 = flatM1(utc('2026-07-01T21:00:00'), 240);
    const [h4] = aggregate(m1, 'H4', ny);
    expect(h4.h).toBe(100 + 239 + 0.5);
    expect(h4.l).toBe(99.5);
  });
});
