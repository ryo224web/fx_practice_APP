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

describe('読み込む月の範囲（ウィンドウ）', () => {
  it('範囲の外の月は捨て、重なる月は読み直さず、時刻順につながる', async () => {
    // @ts-expect-error 型定義のない .mjs
    const { encodeMonth } = await import('../scripts/lib/binfmt.mjs');
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    const fetched: string[] = [];
    const file = (key: string) => {
      const [y, m] = key.split('-').map(Number);
      const t0 = Date.UTC(y, m - 1, 1);
      const rows = Array.from({ length: 3 }, (_, i) => [t0 + i * 60_000, 150 + m, 150 + m, 150 + m, 150 + m]);
      return encodeMonth(rows, [], 3);
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const key = /\/(\d{4}-\d{2})\.bin$/.exec(url)![1];
      fetched.push(key);
      const bytes: Uint8Array = file(key);
      return { ok: true, headers: new Headers({ 'content-type': 'application/octet-stream' }), arrayBuffer: async () => bytes.slice().buffer } as Response;
    }) as typeof fetch;
    try {
      const md = new MarketData('usdjpy', 3, months);
      await md.setWindow(1, 2); // 2〜3 月
      expect(md.loadedMonths).toEqual(['2026-02', '2026-03']);
      await md.setWindow(2, 4); // 3〜5 月（2 月は捨て、3 月は読み直さない）
      expect(md.loadedMonths).toEqual(['2026-03', '2026-04', '2026-05']);
      expect(fetched).toEqual(['2026-02', '2026-03', '2026-04', '2026-05']);
      expect(md.bid.map((b) => b.c)).toEqual([153, 153, 153, 154, 154, 154, 155, 155, 155]);
      await md.setWindow(0, 1); // 前へ（重なり無し）
      expect(md.bid.map((b) => b.c)).toEqual([151, 151, 151, 152, 152, 152]);
      const ts = md.bid.map((b) => b.t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    } finally {
      globalThis.fetch = orig;
    }
  });
});
