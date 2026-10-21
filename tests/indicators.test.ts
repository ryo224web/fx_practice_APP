import { describe, expect, it } from 'vitest';
import { ema, rciAt, sma } from '../src/indicators/calc';

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
});
