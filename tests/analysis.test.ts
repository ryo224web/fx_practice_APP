import { describe, expect, it } from 'vitest';
import { analyze, summarize, tradesCsv, type TradeRecord } from '../src/trade/analysis';

const PIP = 0.01;
const T0 = Date.UTC(2026, 9, 19, 0, 0); // 月曜 9:00（日本時間）
const jst = (t: number) => t + 9 * 3_600_000;

function trade(i: number, pips: number, opts: Partial<TradeRecord> = {}): TradeRecord {
  const openTime = T0 + i * 3_600_000;
  return {
    ticket: i + 1,
    side: 'buy',
    lots: 0.1,
    openTime,
    closeTime: openTime + 30 * 60_000,
    openPrice: 150,
    closePrice: 150 + pips * PIP,
    sl: 149.8,
    tp: null,
    profit: pips * 100,
    pips,
    reason: 'manual',
    mae: null,
    mfe: null,
    ...opts,
  };
}

describe('成績の分析', () => {
  const list = [trade(0, 20), trade(1, -10), trade(2, 30), trade(3, -10), trade(4, -10)];

  it('勝率・プロフィットファクター・リスクリワード・期待値', () => {
    const s = summarize(list, 1_000_000, PIP);
    expect(s.trades).toBe(5);
    expect(s.winRate).toBe(40);
    expect(s.profitFactor).toBeCloseTo(5000 / 3000);
    expect(s.payoff).toBeCloseTo(2500 / 1000);
    expect(s.expectancy).toBe(400);
    expect(s.totalPips).toBe(20);
    expect(s.maxConsecLosses).toBe(2);
    expect(s.avgHold).toBe(30);
  });

  it('最大ドローダウンは残高の山からの下げ', () => {
    // 残高: +2000 → +1000 → +4000 → +3000 → +2000。山 4000 から 2000 下がる
    expect(summarize(list, 1_000_000, PIP).maxDrawdown).toBe(2000);
  });

  it('R は決済時の S/L までの値幅を 1 とした倍率', () => {
    // S/L まで 20 pips。+20 pips は 1R、-10 pips は -0.5R
    const s = summarize([trade(0, 20), trade(1, -10)], 1_000_000, PIP);
    expect(s.avgR).toBeCloseTo(0.25);
  });

  it('曜日・時間帯の内訳は表示の時刻帯（日本時間）で分ける', () => {
    const a = analyze(list, 1_000_000, PIP, jst);
    expect(a.byWeekday[1].trades).toBe(5); // 月曜
    expect(a.byHour[9].trades).toBe(1);
    expect(a.bySession.find((b) => b.label.startsWith('東京'))!.trades).toBe(5);
    expect(a.equity.at(-1)!.balance).toBe(1_002_000);
  });

  it('負けた取引のうち、含み益が出ていた割合を事実として書き出す', () => {
    const withMfe = list.map((t) => ({ ...t, mfe: t.profit < 0 ? 12 : t.pips + 5, mae: -5 }));
    const a = analyze(withMfe, 1_000_000, PIP, jst);
    expect(a.insights.some((x) => x.includes('負けた 3 回のうち 3 回'))).toBe(true);
  });

  it('CSV は Excel で開けるように BOM 付き', () => {
    const csv = tradesCsv(list, (t) => new Date(t).toISOString(), 3, PIP, jst);
    expect(csv.startsWith('﻿注文番号')).toBe(true);
    expect(csv.trim().split('\r\n')).toHaveLength(6);
    expect(csv.split('\r\n')[1].split(',').at(-1)).toBe('月');
  });
});

describe('R（決済時の S/L 基準）', () => {
  it('価格だけで計算するので、銘柄の pip の大きさに依らない', async () => {
    const { rMultiple } = await import('../src/trade/analysis');
    // EURUSD: 建値 1.10000・S/L 1.09800（20 pips）・決済 1.10400（+40 pips）→ 2R
    const eur = { ...trade(0, 40), openPrice: 1.1, sl: 1.098, closePrice: 1.104 };
    expect(rMultiple(eur)).toBeCloseTo(2);
  });

  it('S/L を建値や利益側へ動かした取引は対象外（リスクが決まらない）', async () => {
    const { rMultiple } = await import('../src/trade/analysis');
    expect(rMultiple({ ...trade(0, 20), sl: 150 })).toBeNull(); // 建値
    expect(rMultiple({ ...trade(0, 20), sl: 150.1 })).toBeNull(); // 利益側
    expect(rMultiple({ ...trade(0, 20), side: 'sell', sl: 149.9 })).toBeNull(); // 売りで利益側
  });
});

describe('毎月の振り返りの数字（銘柄別・週別・時間帯別）', () => {
  // 2026-10-19 は月曜。日本時間 9:00 から 1 時間おき
  const list = [
    trade(0, 20, { symbol: 'XAUUSD' }),
    trade(1, -10, { symbol: 'XAUUSD', side: 'sell' }),
    trade(2, 30, { symbol: 'USDJPY' }),
    trade(7 * 24, -10, { symbol: 'USDJPY', side: 'sell' }), // 次の週の月曜 9:00
    trade(7 * 24 + 8, 15, { symbol: 'USDJPY', side: 'sell' }), // 次の週の月曜 17:00（ロンドン）
  ];
  const a = analyze(list, 0, PIP, jst);

  it('銘柄別は純損益の大きい順', () => {
    expect(a.bySymbol.map((b) => [b.label, b.trades, b.net])).toEqual([
      ['USDJPY', 3, 3500],
      ['XAUUSD', 2, 1000],
    ]);
    expect(a.bySymbol[0].longs).toBe(1);
    expect(a.bySymbol[0].shorts).toBe(2);
    expect(a.bySymbol[0].shortWins).toBe(1);
  });

  it('週は月曜始まりで、日本時間のエントリーした日で分ける', () => {
    expect(a.byWeek.map((b) => [b.label, b.trades])).toEqual([
      ['10/19 〜 10/25', 3],
      ['10/26 〜 11/01', 2],
    ]);
  });

  it('時間帯は東京 8〜16 時・ロンドン 16〜21 時・ニューヨーク 21〜翌 5 時', () => {
    const at = (h: number) => analyze([trade(0, 10, { openTime: Date.UTC(2026, 9, 19, h - 9 < 0 ? h + 15 : h - 9) })], 0, PIP, jst).bySession.find((b) => b.trades)!.label;
    expect(at(8)).toMatch(/^東京/);
    expect(at(15)).toMatch(/^東京/);
    expect(at(16)).toMatch(/^ロンドン/);
    expect(at(21)).toMatch(/^ニューヨーク/);
    expect(at(4)).toMatch(/^ニューヨーク/);
    expect(at(5)).toMatch(/^早朝/);
  });

  it('リライアビリティファクター = (平均 ÷ 標準偏差) × √回数、利率 % = 純損益 ÷ 最大ドローダウン × 100', () => {
    const p = list.map((t) => t.profit);
    const mean = p.reduce((x, y) => x + y, 0) / p.length;
    const sd = Math.sqrt(p.reduce((x, v) => x + (v - mean) ** 2, 0) / (p.length - 1));
    expect(a.summary.reliability).toBeCloseTo((mean / sd) * Math.sqrt(p.length), 10);
    // 累積: 2000, 1000, 4000, 3000, 4500 → 山 4000 から 1000 下がる
    expect(a.summary.maxDrawdown).toBe(1000);
    expect(a.summary.returnToDrawdownPct).toBeCloseTo((4500 / 1000) * 100, 10);
    expect(a.summary.months).toBe(1); // どちらの週も 10 月
    expect(a.summary.maxLots).toBe(0.1);
  });
});
