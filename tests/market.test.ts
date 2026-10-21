import { describe, expect, it } from 'vitest';
import { MarketData } from '../src/replay/market';

describe('Ask の欠けと誤り', () => {
  it('Bid より安い Ask は使わず、直前のスプレッドで推定する', () => {
    const md = new MarketData('usdjpy', 3, []);
    const bar = (t: number, p: number) => ({ t, o: p, h: p, l: p, c: p });
    // 1 本目は正しい（スプレッド 0.004）、2 本目の Ask は Bid より安い（誤り）、3 本目は欠け
    (md as unknown as { setData: (b: unknown[], a: unknown[]) => void }).setData(
      [bar(0, 150), bar(60_000, 150.1), bar(120_000, 150.2)],
      [bar(0, 150.004), bar(60_000, 149.9), null],
    );
    expect([...md.askEstimated]).toEqual([0, 1, 1]);
    expect(md.ask[1].c).toBeCloseTo(150.104);
    expect(md.ask[2].c).toBeCloseTo(150.204);
  });
});
