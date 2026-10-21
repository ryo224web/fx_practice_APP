import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/core/candles';
import { symbolSpec } from '../src/core/symbols';
import { Account, replayAccount, type Action, type Baseline, type PriceFeed } from '../src/trade/account';

const spec = symbolSpec('usdjpy', 3);
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const SPREAD = 0.004;

/** [始値, 高値, 安値, 終値] の Bid から 1 分足を作る。Ask は一定のスプレッドを足す */
function feedOf(rows: [number, number, number, number][]): PriceFeed {
  const bid: Bar[] = rows.map(([o, h, l, c], i) => ({ t: T0 + i * 60_000, o, h, l, c }));
  const ask = bid.map((b) => ({ t: b.t, o: b.o + SPREAD, h: b.h + SPREAD, l: b.l + SPREAD, c: b.c + SPREAD }));
  return { bid, ask, jpyRate: () => 1 };
}

const baseline: Baseline = {
  time: T0,
  balance: 1_000_000,
  history: [{ kind: 'balance', ticket: 1, time: T0, amount: 1_000_000, comment: 'Deposit' }],
  nextTicket: 2,
};

function newAccount() {
  return new Account(spec, { leverage: 500 }, baseline);
}

describe('仮想口座', () => {
  it('買いは Ask で建てて Bid で決済する', () => {
    const feed = feedOf([
      [150, 150, 150, 150],
      [150, 150.2, 150, 150.1],
    ]);
    const a = newAccount();
    expect(a.apply(feed, 0, { t: T0, kind: 'market', side: 'buy', lots: 0.1, sl: null, tp: null })).toBeNull();
    expect(a.positions[0].openPrice).toBeCloseTo(150.004);
    a.processBar(feed, 1);
    expect(a.apply(feed, 1, { t: T0 + 60_000, kind: 'close', ticket: 2 })).toBeNull();
    const h = a.history.at(-1)!;
    expect(h.kind === 'trade' && h.closePrice).toBe(150.1);
    // (150.1 - 150.004) × 10,000 通貨 = 960 円
    expect(a.balance).toBeCloseTo(1_000_960);
  });

  it('売りの S/L は Ask で判定する（Bid が届かなくても Ask が届けば決済）', () => {
    const feed = feedOf([
      [150, 150, 150, 150],
      [150, 150.098, 149.99, 150.05],
    ]);
    const a = newAccount();
    a.apply(feed, 0, { t: T0, kind: 'market', side: 'sell', lots: 1, sl: 150.1, tp: null });
    const ev = a.processBar(feed, 1);
    // Bid の高値は 150.098 だが、Ask の高値は 150.102 で S/L 150.1 に届く
    expect(ev).toEqual([{ kind: 'sl', ticket: 2, time: T0 + 60_000 }]);
    expect(a.positions).toHaveLength(0);
  });

  it('窓を開けて S/L を飛び越えたら始値で決済する', () => {
    const feed = feedOf([
      [150, 150, 150, 150],
      [149.5, 149.6, 149.4, 149.5],
    ]);
    const a = newAccount();
    a.apply(feed, 0, { t: T0, kind: 'market', side: 'buy', lots: 0.1, sl: 149.8, tp: null });
    a.processBar(feed, 1);
    const h = a.history.at(-1)!;
    expect(h.kind === 'trade' && h.closePrice).toBe(149.5);
  });

  it('同じ足で S/L と T/P の両方に届いたら、陽線は安値が先とみなす', () => {
    const feed = feedOf([
      [150, 150, 150, 150],
      [150, 150.5, 149.5, 150.2],
    ]);
    const a = newAccount();
    a.apply(feed, 0, { t: T0, kind: 'market', side: 'buy', lots: 0.1, sl: 149.8, tp: 150.3 });
    expect(a.processBar(feed, 1)[0].kind).toBe('sl');
  });

  it('指値注文は次の足から約定し、置いた足では約定しない', () => {
    const feed = feedOf([
      [150, 150, 149.9, 150],
      [150, 150, 149.85, 149.95],
    ]);
    const a = newAccount();
    expect(a.apply(feed, 0, { t: T0, kind: 'pending', type: 'buylimit', price: 149.86, lots: 0.1, sl: null, tp: null })).toBeNull();
    expect(a.positions).toHaveLength(0);
    // 2 本目の Ask 安値は 149.854 → 149.86 で約定
    expect(a.processBar(feed, 1)[0].kind).toBe('open');
    expect(a.positions[0].openPrice).toBe(149.86);
  });

  it('S/L・T/P や指値の位置が逆なら断る', () => {
    const feed = feedOf([[150, 150, 150, 150]]);
    const a = newAccount();
    expect(a.apply(feed, 0, { t: T0, kind: 'market', side: 'buy', lots: 0.1, sl: 150.1, tp: null })).toMatch(/S\/L/);
    expect(a.apply(feed, 0, { t: T0, kind: 'pending', type: 'buylimit', price: 150.1, lots: 0.1, sl: null, tp: null })).toMatch(/Buy Limit/);
  });

  it('一部決済すると残りは新しい注文番号で残る', () => {
    const feed = feedOf([[150, 150, 150, 150]]);
    const a = newAccount();
    a.apply(feed, 0, { t: T0, kind: 'market', side: 'buy', lots: 0.3, sl: null, tp: null });
    a.apply(feed, 0, { t: T0, kind: 'close', ticket: 2, lots: 0.1 });
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ ticket: 3, lots: 0.2, comment: 'from #2' });
  });

  it('記録した操作を再生すると同じ口座になる（巻き戻しに使う）', () => {
    const feed = feedOf([
      [150, 150, 150, 150],
      [150, 150.2, 150, 150.1],
      [150.1, 150.4, 150.1, 150.3],
    ]);
    const actions: Action[] = [{ t: T0, kind: 'market', side: 'buy', lots: 0.1, sl: null, tp: 150.25 }];
    const { account } = replayAccount(spec, { leverage: 500 }, baseline, actions, feed, 0, 2);
    const h = account.history.at(-1)!;
    expect(h.kind === 'trade' && h.reason).toBe('tp');
    // 1 本目までなら、まだ保有中
    expect(replayAccount(spec, { leverage: 500 }, baseline, actions, feed, 0, 1).account.positions).toHaveLength(1);
  });
});

describe('リスクからロットを決める', () => {
  it('残高 100 万円の 1%（1 万円）、損切り 20 pips なら USDJPY は 0.5 ロット', async () => {
    const { lotsForRisk } = await import('../src/trade/risk');
    expect(lotsForRisk({ riskJpy: 10_000, entry: 150, sl: 149.8, contract: 100_000, rate: 1 })).toBe(0.5);
  });

  it('割り切れないときは切り捨て（損失が指定を超えないように）', async () => {
    const { lotsForRisk, lossAt } = await import('../src/trade/risk');
    const lots = lotsForRisk({ riskJpy: 10_000, entry: 150, sl: 149.77, contract: 100_000, rate: 1 });
    expect(lots).toBe(0.43);
    expect(lossAt(lots, 150, 149.77, 100_000, 1)).toBeLessThanOrEqual(10_000);
  });
});

describe('逆指値が約定した足の S/L', () => {
  it('約定より前の安値・始値では S/L に掛けない（次の足から見る）', () => {
    // 2 本目: 始値 149.00 → 安値 148.90 → 高値 150.20 で、150.00 の買い逆指値が約定。
    // S/L 149.50 は約定より前の始値・安値より上なので、同じ足で判定すると約定した直後に決済になってしまう
    const feed = feedOf([
      [149.0, 149.0, 149.0, 149.0],
      [149.0, 150.2, 148.9, 150.1],
      [150.1, 150.15, 149.4, 149.6],
    ]);
    const a = newAccount();
    a.apply(feed, 0, { t: T0, kind: 'pending', type: 'buystop', price: 150, lots: 0.1, sl: 149.5, tp: null });
    expect(a.processBar(feed, 1).map((e) => e.kind)).toEqual(['open']);
    expect(a.positions).toHaveLength(1);
    // 次の足で安値 149.40 が S/L 149.50 に届く
    expect(a.processBar(feed, 2).map((e) => e.kind)).toEqual(['sl']);
  });
});
