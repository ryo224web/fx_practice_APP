import { describe, expect, it } from 'vitest';
import { simulateTp, summarizeTp } from '../src/trade/tpSim';
import { tallyByName } from '../src/trade/lossReasons';
import type { TradeRecord } from '../src/trade/analysis';

const M = 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ t: i * M, o, h, l, c });

describe('T/P を変えたら（試算）', () => {
  // 買い: 建値 100、S/L 99（1R = 1）。建てた足（0）の中は見ない
  const buy = { side: 'buy' as const, openTime: 0, openPrice: 100, sl: 99 };
  const bars = [bar(0, 100, 105, 90, 100), bar(1, 100, 101.2, 99.5, 101), bar(2, 101, 102.6, 100.5, 102.5), bar(3, 102.5, 102.6, 98, 98)];

  it('T/P に先に届けば k R、S/L に先に届けば -1R', () => {
    expect(simulateTp(buy, bars, 0, 1)).toBe(1);
    expect(simulateTp(buy, bars, 0, 2.5)).toBe(2.5);
    expect(simulateTp(buy, bars, 0, 3)).toBe(-1);
  });

  it('足が尽きたら決まらず。S/L が無い・建値より有利なら数えない', () => {
    expect(simulateTp(buy, bars.slice(0, 3), 0, 3)).toBe('open');
    expect(simulateTp({ ...buy, sl: null }, bars, 0, 1)).toBeNull();
    expect(simulateTp({ ...buy, sl: 100.5 }, bars, 0, 1)).toBeNull();
  });

  it('同じ足で両方に届いたら、陽線は安値が先・陰線は高値が先', () => {
    expect(simulateTp(buy, [bar(1, 100, 102, 98, 101)], 0, 1)).toBe(-1);
    expect(simulateTp(buy, [bar(1, 100, 102, 98, 99)], 0, 1)).toBe(1);
    const sell = { side: 'sell' as const, openTime: 0, openPrice: 100, sl: 101 };
    expect(simulateTp(sell, [bar(1, 100, 102, 98, 101)], 0, 1)).toBe(1);
    expect(simulateTp(sell, [bar(1, 100, 102, 98, 99)], 0, 1)).toBe(-1);
  });

  it('売りは Ask（Bid + スプレッド）で決済する。始値が越えていれば始値で決済', () => {
    const sell = { side: 'sell' as const, openTime: 0, openPrice: 100, sl: 101 };
    // Bid の安値 98.95 でも Ask は 99.05 で、T/P 99 に届かない。高値 100.95 で Ask 101.05 が S/L に届く
    expect(simulateTp(sell, [bar(1, 100, 100.95, 98.95, 100)], 0.1, 1)).toBe(-1);
    expect(simulateTp(buy, [bar(1, 98.5, 99, 98, 98.8)], 0, 1)).toBeCloseTo(-1.5);
  });

  it('集計: 決まらず・数えないを除き、R の山からの下げも出す', () => {
    const r = summarizeTp(2, [2, -1, -1, 'open', null, 2]);
    expect(r).toMatchObject({ trades: 4, wins: 2, losses: 2, open: 1, totalR: 2, maxDrawdownR: 2, winRate: 50 });
  });
});

describe('札ごとの勝ち負け', () => {
  const rec = (ticket: number, profit: number, close: number): TradeRecord => ({
    ticket, side: 'buy', lots: 1, openTime: 0, closeTime: 1, openPrice: 100, closePrice: close, sl: 99, tp: null, profit, pips: 0, reason: null, mae: null, mfe: null,
  });
  it('勝因と敗因を同じ名前（空白は無視）でまとめ、R を数える。区切りは数えない', () => {
    const loss = [{ id: 'r1', name: '38.2' }, { id: 'r2', name: 'H4 逆' }, { id: 'r3', name: '-----' }];
    const win = [{ id: 'w1', name: '38.2' }, { id: 'w2', name: 'H4逆' }];
    const tags: Record<number, string[]> = { 1: ['w1', 'w2'], 2: ['r1', 'r3'], 3: ['r2', 'r2'] };
    const recs = [rec(1, 100, 101), rec(2, -100, 99), rec(3, -50, 99.5)];
    const rows = tallyByName(recs, loss, win, (r) => tags[r.ticket] ?? [], (r) => r.closePrice - r.openPrice);
    expect(rows.map((x) => [x.name, x.trades, x.wins, x.losses, x.r])).toEqual([
      ['38.2', 2, 1, 1, 0],
      ['H4逆', 2, 1, 1, 0.5],
    ]);
  });
});
