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

describe('固定スプレッド', () => {
  it('Ask = Bid + 固定スプレッド（データの Ask は使わない）。戻すとデータの Ask になる', () => {
    const md = new MarketData('usdjpy', 3, []);
    const bar = (t: number, p: number) => ({ t, o: p, h: p + 0.01, l: p - 0.01, c: p });
    (md as unknown as { setData: (b: unknown[], a: unknown[]) => void }).setData([bar(0, 150), bar(60_000, 150.1)], [bar(0, 150.02), null]);
    md.setFixedSpread(0.003);
    expect(md.spreadIsFixed).toBe(true);
    expect(md.ask.map((a) => a.c)).toEqual([150.003, 150.103]);
    expect(md.ask[0].h).toBeCloseTo(150.013);
    expect([...md.askEstimated]).toEqual([0, 0]);
    md.setFixedSpread(null);
    expect(md.ask[0].c).toBe(150.02);
    expect(md.askEstimated[1]).toBe(1);
  });
});
