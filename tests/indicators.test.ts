import { describe, expect, it } from 'vitest';
import { ema, macd, rciAt, sma } from '../src/indicators/calc';

describe('インジケーター', () => {
  it('単純移動平均', () => {
    const v = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(v[1])).toBe(true);
    expect([...v.slice(2)]).toEqual([2, 3, 4]);
  });

  it('指数移動平均は単純移動平均から始まる', () => {
    const v = ema([1, 2, 3, 4], 3);
    expect(v[2]).toBe(2);
    expect(v[3]).toBe(2 + 0.5 * (4 - 2));
  });

  it('RCI は上がり続けると +100、下がり続けると -100', () => {
    const up = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(rciAt(up, 8, 9)).toBeCloseTo(100);
    expect(rciAt(up.slice().reverse(), 8, 9)).toBeCloseTo(-100);
    expect(Number.isNaN(rciAt(up, 7, 9))).toBe(true);
  });

  it('RCI の最後の値を作りかけの足の値に差し替えられる', () => {
    const up = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    // 最後の足が一番安ければ、上昇の流れが崩れて 100 より小さくなる
    expect(rciAt(up, 8, 9, 0)).toBeLessThan(100);
  });

  it('MACD は EMA の差、シグナルはその EMA（素直な書き方と同じ）', () => {
    let x = 100;
    const closes = Array.from({ length: 300 }, (_, i) => (x += Math.sin(i * 0.37) + Math.cos(i * 0.11) * 0.5));
    const m = macd(closes, 12, 26, 9);
    const f = ema(closes, 12);
    const s = ema(closes, 26);
    expect(Number.isNaN(m.line[24])).toBe(true);
    expect(m.line[25]).toBeCloseTo(f[25] - s[25], 12);
    // シグナルは MACD が出た 25 本目から 9 本で始める
    const line = Array.from(m.line.slice(25));
    const sig = ema(line, 9);
    expect(Number.isNaN(m.signal[32])).toBe(true);
    for (let i = 33; i < 300; i++) {
      expect(m.signal[i]).toBeCloseTo(sig[i - 25], 12);
      expect(m.hist[i]).toBeCloseTo(m.line[i] - m.signal[i], 12);
    }
    // その足までの値しか使わない（後ろを変えても前は同じ）
    const m2 = macd([...closes.slice(0, 200), ...closes.slice(200).map((v) => v * 2)], 12, 26, 9);
    expect(m2.signal[199]).toBe(m.signal[199]);
  });
});
