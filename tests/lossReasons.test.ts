import { describe, expect, it } from 'vitest';
import { isFiboReason, missingReasons, newReasonId, tallyReasons, type LossReason } from '../src/trade/lossReasons';
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

  it('keeps the order of the reason list', () => {
    const list: LossReason[] = [
      { id: 'x', name: 'H1 3波じゃない' },
      { id: 'f1', name: '38.2' },
      { id: 'f2', name: '61.8' },
    ];
    const tags: Record<number, string[]> = { 1: ['x'], 2: ['x'], 3: ['x'], 4: ['f1'], 5: ['f2'], 6: ['f2'] };
    const t = tallyReasons([1, 2, 3, 4, 5, 6].map((n) => rec(n, -10, -1)), list, (r) => tags[r.ticket] ?? []);
    expect(t.rows.map((r) => r.reason.id)).toEqual(['x', 'f1', 'f2']);
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

  it('finds reasons the other list has and this one lacks', () => {
    expect(['38.2', '61.8-78.6', '0 - 23.6', '23.6〜38.2'].every(isFiboReason)).toBe(true);
    expect(['H1 3波じゃない', '50%', 'SL 38.2'].some(isFiboReason)).toBe(false);
    const loss = [{ id: 'r1', name: 'エントリーが遅い' }, { id: 'r2', name: '38.2' }, { id: 'r3', name: '61.8 - 78.6' }, { id: 'r4', name: '50' }];
    expect(missingReasons([{ id: 'w1', name: '61.8-78.6' }], loss)).toEqual(['エントリーが遅い', '38.2', '50']);
  });
});
