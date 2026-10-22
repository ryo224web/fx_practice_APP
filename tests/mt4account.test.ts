// MT4 の取引を口座にする（src/mt4/account.ts）
import { describe, expect, it } from 'vitest';
import { symbolSpec } from '../src/core/symbols';
import { buildMt4Account } from '../src/mt4/account';
import type { Mt4Trade } from '../src/mt4/history';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 28);
const trade = (p: Partial<Mt4Trade>): Mt4Trade => ({
  ticket: 1,
  side: 'sell',
  lots: 0.03,
  symbol: 'USDJPY',
  openServer: T0,
  openPrice: 156.928,
  sl: 157.19,
  tp: 155.912,
  closeServer: T0 + H,
  closePrice: 157.19,
  commission: 0,
  swap: 0,
  profit: -808,
  comment: '',
  ...p,
});
const trades: Mt4Trade[] = [
  trade({ ticket: 10 }),
  trade({ ticket: 11, side: 'buy', openServer: T0 + 2 * H, openPrice: 157, sl: null, tp: null, closeServer: T0 + 5 * H, closePrice: 157.5, profit: 1500, swap: -20, commission: -30 }),
  trade({ ticket: 12, symbol: 'EURUSD', side: 'buy', openServer: T0 + H, openPrice: 1.1, sl: null, tp: null, closeServer: T0 + 3 * H, closePrice: 1.101, profit: 4000 }),
  trade({ ticket: 13, openServer: T0 - 10 * H, closeServer: T0 - 9 * H, profit: 99999 }), // 検証を始める前に決済
  trade({ ticket: 14, openServer: T0 + 4 * H, closeServer: null, closePrice: null, profit: 0 }), // まだ保有中
];
const build = (now: number) =>
  buildMt4Account(symbolSpec('usdjpy', 3), { leverage: 500 }, trades, { start: T0 - H, balance: 1_000_000, now, symbol: 'usdjpy', toUtc: (s) => s, pipOf: (s) => (/jpy/i.test(s) ? 0.01 : 0.0001) });

describe('MT4 の取引の口座', () => {
  it('建った時刻からは保有中、決済した時刻からは口座履歴（記録の損益）', () => {
    const a1 = build(T0 + 30 * 60_000);
    expect(a1.positions.map((p) => p.ticket)).toEqual([10]);
    expect(a1.balance).toBe(1_000_000);
    const a2 = build(T0 + 2.5 * H);
    // 10 は決済済み（-808）。11 は保有中。EURUSD の 12 は保有中だが今の銘柄ではないので出さない
    expect(a2.positions.map((p) => p.ticket)).toEqual([11]);
    expect(a2.balance).toBe(1_000_000 - 808);
    const h = a2.history.find((x) => x.kind === 'trade' && x.ticket === 10);
    expect(h && h.kind === 'trade' && h.reason).toBe('sl');
  });

  it('ほかの銘柄の決済も残高に入る。損益はスワップ・手数料込み。始める前の取引は入らない', () => {
    const a = build(T0 + 6 * H);
    expect(a.balance).toBe(1_000_000 - 808 + 4000 + 1500 - 20 - 30);
    expect(a.history.filter((x) => x.kind === 'trade').map((x) => x.ticket)).toEqual([10, 12, 11]);
    expect(a.positions.map((p) => p.ticket)).toEqual([14]);
    expect(a.history[0]).toMatchObject({ kind: 'balance', amount: 1_000_000 });
  });
});
