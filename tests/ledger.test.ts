// 区切り（checkpoint）から計算し直しても・価格データを 1 か月ずつ読みながら計算しても、
// 最初から全部を計算したのと 1 円も違わないことを確かめる。

import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/core/candles';
import { symbolSpec } from '../src/core/symbols';
import { replayAccount, type Account, type Action, type Baseline, type PendingType, type PriceFeed } from '../src/trade/account';
import { checkpointAtOrBefore, restoreAccount, Runner } from '../src/trade/ledger';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const spec = symbolSpec('usdjpy', 3);
const settings = { leverage: 500 };
const T0 = Date.UTC(2026, 0, 5); // 月曜

/** 3 か月分の 1 分足（平日だけ）。小数 3 桁 */
function makeFeed(seed: number): PriceFeed {
  const r = rng(seed);
  const bid: Bar[] = [];
  let p = 150;
  for (let t = T0; t < Date.UTC(2026, 3, 1); t += 60_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const o = p;
    p = Math.round((p + (r() - 0.5) * 0.06) * 1000) / 1000;
    const h = Math.round((Math.max(o, p) + r() * 0.02) * 1000) / 1000;
    const l = Math.round((Math.min(o, p) - r() * 0.02) * 1000) / 1000;
    bid.push({ t, o, h, l, c: p });
  }
  const ask = bid.map((b) => ({ t: b.t, o: b.o + 0.003, h: b.h + 0.003, l: b.l + 0.003, c: b.c + 0.003 }));
  return { bid, ask, jpyRate: () => 1 };
}

/** ランダムな操作（成行・指値・逆指値・変更・決済・一部決済・取消） */
function makeActions(feed: PriceFeed, seed: number): Action[] {
  const r = rng(seed);
  const out: Action[] = [];
  const n = feed.bid.length;
  for (let k = 0; k < 300; k++) {
    const i = 1 + Math.floor(r() * (n - 2));
    const t = feed.bid[i].t;
    const price = feed.bid[i].c;
    const kind = r();
    const ticket = 2 + Math.floor(r() * 120);
    if (kind < 0.35) {
      const side = r() < 0.5 ? 'buy' : 'sell';
      const d = 0.1 + r() * 0.5;
      out.push({ t, kind: 'market', side, lots: 0.1, sl: side === 'buy' ? price - d : price + d + 0.003, tp: r() < 0.5 ? null : side === 'buy' ? price + d : price - d });
    } else if (kind < 0.55) {
      const types: PendingType[] = ['buylimit', 'selllimit', 'buystop', 'sellstop'];
      const type = types[Math.floor(r() * 4)];
      const off = 0.05 + r() * 0.3;
      const pr = type === 'buylimit' || type === 'sellstop' ? price - off : price + off;
      out.push({ t, kind: 'pending', type, price: pr, lots: 0.2, sl: null, tp: null });
    } else if (kind < 0.7) out.push({ t, kind: 'close', ticket, ...(r() < 0.3 ? { lots: 0.05 } : {}) });
    else if (kind < 0.85) out.push({ t, kind: 'modify', ticket, sl: price - 0.5, tp: price + 0.5 });
    else out.push({ t, kind: 'cancel', ticket });
  }
  return out.sort((a, b) => a.t - b.t);
}

const baseline: Baseline = { time: T0, balance: 1_000_000, history: [], nextTicket: 2 };

function state(a: Account) {
  return { balance: a.balance, history: a.history, positions: a.positions, orders: a.orders, nextTicket: a.nextTicket };
}

/** t 以前で最後の足の位置 */
const idxAt = (feed: PriceFeed, t: number) => {
  let i = 0;
  while (i + 1 < feed.bid.length && feed.bid[i + 1].t <= t) i++;
  return i;
};

describe('区切りから・1 か月ずつの計算が、最初からの計算と一致する', () => {
  const feed = makeFeed(1);
  const actions = makeActions(feed, 2);
  const full = replayAccount(spec, settings, baseline, actions, feed, 0, feed.bid.length - 1);

  it('Runner で最初から最後まで = これまでの計算（replayAccount）', () => {
    const runner = new Runner(restoreAccount(spec, settings, baseline, [], null), actions.slice(), [], true);
    runner.run(feed, 0, feed.bid.length - 1);
    expect(state(runner.account)).toEqual(state(full.account));
    expect(runner.actions).toEqual(full.actions);
    // 3 か月なので、月の変わり目の区切りが 2 つ
    expect(runner.checkpoints.length).toBe(2);
    expect(full.account.history.filter((h) => h.kind === 'trade').length).toBeGreaterThan(30);
  });

  it('価格データを 1 か月ずつ読み込みながら計算しても同じ', () => {
    const runner = new Runner(restoreAccount(spec, settings, baseline, [], null), actions.slice(), [], true);
    for (const m of [0, 1, 2]) {
      // その月だけの価格データ（添字は 0 から始まる別の配列）
      const lo = Date.UTC(2026, m, 1);
      const hi = Date.UTC(2026, m + 1, 1);
      const keep = feed.bid.map((b, i) => [b, i] as const).filter(([b]) => b.t >= lo && b.t < hi).map(([, i]) => i);
      const part: PriceFeed = { bid: keep.map((i) => feed.bid[i]), ask: keep.map((i) => feed.ask[i]), jpyRate: () => 1 };
      runner.run(part, 0, part.bid.length - 1);
    }
    expect(state(runner.account)).toEqual(state(full.account));
  });

  it('途中のどの時刻へも、手前の区切りから計算し直せば同じ口座になる（巻き戻し・開き直し）', () => {
    const whole = new Runner(restoreAccount(spec, settings, baseline, [], null), actions.slice(), [], true);
    whole.run(feed, 0, feed.bid.length - 1);
    const r = rng(9);
    for (let n = 0; n < 15; n++) {
      const target = feed.bid[Math.floor(r() * feed.bid.length)].t;
      const ti = idxAt(feed, target);
      const expected = replayAccount(spec, settings, baseline, actions, feed, 0, ti);
      const cp = checkpointAtOrBefore(whole.checkpoints, target);
      const acts = actions.filter((a) => a.t <= target);
      const runner = new Runner(restoreAccount(spec, settings, baseline, whole.account.history, cp), acts, whole.checkpoints.filter((c) => c.time <= (cp?.time ?? -1)), !cp);
      runner.run(feed, cp ? idxAt(feed, cp.time) + 1 : 0, ti);
      expect(state(runner.account)).toEqual(state(expected.account));
    }
  });

  it('同じ足を 2 回渡しても二重に処理しない', () => {
    const runner = new Runner(restoreAccount(spec, settings, baseline, [], null), actions.slice(), [], true);
    const mid = Math.floor(feed.bid.length / 2);
    runner.run(feed, 0, mid);
    runner.run(feed, mid - 500, feed.bid.length - 1); // 重ねて渡す
    expect(state(runner.account)).toEqual(state(full.account));
  });
});

describe('含み損益の最大・最小（MAE・MFE）', () => {
  it('決済した取引には必ず入り、含み損は 0 以下・含み益は 0 以上で、決済した値幅も含む', () => {
    const feed = makeFeed(3);
    const { account } = replayAccount(spec, settings, baseline, makeActions(feed, 4), feed, 0, feed.bid.length - 1);
    const trades = account.history.filter((h) => h.kind === 'trade');
    expect(trades.length).toBeGreaterThan(30);
    for (const h of trades) {
      if (h.kind !== 'trade') continue;
      const done = (h.closePrice - h.openPrice) * (h.side === 'buy' ? 1 : -1);
      expect(h.mae).toBeLessThanOrEqual(Math.min(0, done) + 1e-9);
      expect(h.mfe).toBeGreaterThanOrEqual(Math.max(0, done) - 1e-9);
    }
  });
});
