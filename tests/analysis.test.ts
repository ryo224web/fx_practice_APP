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
