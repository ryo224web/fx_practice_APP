import { describe, expect, it } from 'vitest';
import { newReasonId, tallyReasons, type LossReason } from '../src/trade/lossReasons';
import type { TradeRecord } from '../src/trade/analysis';

const rec = (ticket: number, profit: number, pips: number, closeTime = ticket): TradeRecord => ({
  ticket,
  side: 'buy',
  lots: 0.1,
  openTime: 0,
  closeTime,
  openPrice: 1,
  closePrice: 1,
  sl: null,
  tp: null,
  profit,
  pips,
  reason: null,
  mae: null,
  mfe: null,
});

const reasons: LossReason[] = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

describe('tallyReasons', () => {
  it('counts each tag, sums profit and pips, and lists untagged losses', () => {
    const tags: Record<number, string[]> = { 1: ['a'], 2: ['a', 'b'], 3: ['b'], 5: ['gone'] };
    const t = tallyReasons([rec(1, -100, -10), rec(2, -200, -20), rec(3, 50, 5), rec(4, -30, -3), rec(5, -40, -4), rec(6, 70, 7)], reasons, (r) => tags[r.ticket] ?? []);
    expect(t.rows.map((r) => [r.reason.id, r.count, r.profit, r.pips])).toEqual([
      ['a', 2, -300, -30],
      ['b', 2, -150, -15],
    ]);
    expect(t.rows[0].trades.map((r) => r.ticket)).toEqual([1, 2]);
    // 消した敗因（gone）だけの負けは、札の無い負けとして出す。新しい順
    expect(t.untagged.map((r) => r.ticket)).toEqual([5, 4]);
    // 勝ちを数えるときは、札の無い勝ち（3 は札あり）
    const w = tallyReasons([rec(1, -100, -10), rec(3, 50, 5), rec(6, 70, 7), rec(7, 0, 0)], reasons, (r) => tags[r.ticket] ?? [], true);
    expect(w.untagged.map((r) => r.ticket)).toEqual([6]);
  });

  it('does not count the same tag twice on one trade', () => {
    const t = tallyReasons([rec(1, -10, -1)], reasons, () => ['a', 'a']);
    expect(t.rows[0].count).toBe(1);
  });

  it('makes ids that do not collide', () => {
    expect(newReasonId([{ id: 'r2', name: 'x' }])).toBe('r3');
    expect(newReasonId([{ id: 'r1', name: 'x' }, { id: 'r3', name: 'y' }])).toBe('r4');
    expect(newReasonId([], 'w')).toBe('w1');
  });
});
