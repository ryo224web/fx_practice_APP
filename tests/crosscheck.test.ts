// 数値の計算を、別の素直な書き方（遅いが間違えにくい）と突き合わせるテスト。
// 乱数で作った値動きで、本番の計算と結果が一致するかを確かめる。

import { describe, expect, it } from 'vitest';
import { aggregate, type Bar, type Timeframe } from '../src/core/candles';
import { symbolSpec } from '../src/core/symbols';
import { serverOffsetMinutes, type ServerTimeRule } from '../src/core/time';
import { ema, rciAt, sma } from '../src/indicators/calc';
import { replayAccount, type Action, type Baseline, type PriceFeed } from '../src/trade/account';
import { summarize, type TradeRecord } from '../src/trade/analysis';
import { lossAt, lotsForRisk } from '../src/trade/risk';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 3 桁（円）に丸めたランダムウォーク */
function walk(n: number, seed = 1, start = 150): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += (r() - 0.5) * 0.05;
    out.push(Math.round(p * 1000) / 1000);
  }
  return out;
}

describe('インジケーター（素直な計算と比べる）', () => {
  const closes = walk(600, 7);

  it('SMA = 直近 period 本の平均', () => {
    for (const period of [1, 6, 20, 200]) {
      const v = sma(closes, period);
      for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) expect(Number.isNaN(v[i])).toBe(true);
        else {
          const win = closes.slice(i - period + 1, i + 1);
          expect(v[i]).toBeCloseTo(win.reduce((a, b) => a + b, 0) / period, 9);
        }
      }
    }
  });

  it('EMA = SMA から始めて 2/(n+1) で更新', () => {
    for (const period of [5, 20, 100]) {
      const v = ema(closes, period);
      let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      expect(v[period - 1]).toBeCloseTo(prev, 9);
      for (let i = period; i < closes.length; i++) {
        prev = closes[i] * (2 / (period + 1)) + prev * (1 - 2 / (period + 1));
        expect(v[i]).toBeCloseTo(prev, 9);
      }
    }
  });

  it('RCI = スピアマンの順位相関 × 100（順位は数え上げで求める）', () => {
    // 同じ値が出やすいように 1 pip 単位の値で試す
    const coarse = closes.map((c) => Math.round(c * 100) / 100);
    for (const period of [9, 26, 52]) {
      for (let end = period - 1; end < coarse.length; end += 7) {
        const win = Array.from({ length: period }, (_, j) => coarse[end - j]); // j=0 が一番新しい
        // 価格の順位: 自分より高い数 + 1、同じ値は平均順位
        const priceRank = win.map((v) => {
          const higher = win.filter((x) => x > v).length;
          const same = win.filter((x) => x === v).length;
          return higher + (same + 1) / 2;
        });
        const d2 = win.reduce((a, _, j) => a + (j + 1 - priceRank[j]) ** 2, 0);
        const expected = (1 - (6 * d2) / (period * (period ** 2 - 1))) * 100;
        expect(rciAt(coarse, end, period)).toBeCloseTo(expected, 9);
      }
    }
  });
});

describe('上位足（素直なまとめ方と比べる）', () => {
  const ny: ServerTimeRule = { kind: 'ny-close' };
  // 夏時間の切り替え（2026-11-01）をまたぐ 3 週間分の 1 分足（週末を除く）
  const t0 = Date.UTC(2026, 9, 18, 21);
  const prices = walk(21 * 1440, 3);
  const m1: Bar[] = [];
  prices.forEach((p, i) => {
    const t = t0 + i * 60_000;
    const day = new Date(t + serverOffsetMinutes(ny, t) * 60_000).getUTCDay();
    if (day === 0 || day === 6) return; // サーバー時刻の土日は休場
    m1.push({ t, o: p, h: p + 0.01, l: p - 0.01, c: p + 0.002 });
  });

  for (const [tf, minutes] of [
    ['M5', 5],
    ['H1', 60],
    ['H4', 240],
    ['D1', 1440],
  ] as [Timeframe, number][]) {
    it(`${tf}: サーバー時刻で区切って始値・高値・安値・終値をまとめる`, () => {
      const groups = new Map<number, Bar[]>();
      for (const b of m1) {
        const server = b.t + serverOffsetMinutes(ny, b.t) * 60_000;
        const key = Math.floor(server / (minutes * 60_000));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(b);
      }
      const expected = [...groups.values()].map((g) => ({
        o: g[0].o,
        h: Math.max(...g.map((b) => b.h)),
        l: Math.min(...g.map((b) => b.l)),
        c: g[g.length - 1].c,
      }));
      const got = aggregate(m1, tf, ny).map(({ o, h, l, c }) => ({ o, h, l, c }));
      expect(got).toEqual(expected);
    });
  }
});

describe('仮想口座（素直な計算と比べる）', () => {
  it('成行の売買を繰り返しても、残高 = 初期資金 + 各取引の (決済 - 建値) × 方向 × 数量', () => {
    const spec = symbolSpec('usdjpy', 3);
    const prices = walk(400, 11);
    const bid: Bar[] = prices.map((p, i) => ({ t: i * 60_000, o: p, h: p + 0.02, l: p - 0.02, c: p }));
    const ask: Bar[] = bid.map((b) => ({ ...b, o: b.o + 0.004, h: b.h + 0.004, l: b.l + 0.004, c: b.c + 0.004 }));
    const feed: PriceFeed = { bid, ask, jpyRate: () => 1 };
    const baseline: Baseline = { time: 0, balance: 1_000_000, history: [], nextTicket: 1 };
    const r = rng(5);
    const actions: Action[] = [];
    const expected: number[] = [];
    let ticket = 1;
    for (let i = 1; i < 380; i += 10) {
      const side = r() < 0.5 ? 'buy' : 'sell';
      const lots = Math.round((0.01 + r() * 2) * 100) / 100;
      const j = i + 1 + Math.floor(r() * 8);
      actions.push({ t: bid[i].t, kind: 'market', side, lots, sl: null, tp: null });
      actions.push({ t: bid[j].t, kind: 'close', ticket });
      const open = side === 'buy' ? ask[i].c : bid[i].c;
      const close = side === 'buy' ? bid[j].c : ask[j].c;
      expected.push((close - open) * (side === 'buy' ? 1 : -1) * lots * 100_000);
      ticket++;
    }
    const { account } = replayAccount(spec, { leverage: 500 }, baseline, actions, feed, 0, bid.length - 1);
    const trades = account.history.filter((h) => h.kind === 'trade');
    expect(trades).toHaveLength(expected.length);
    trades.forEach((h, k) => expect(h.kind === 'trade' && h.profit).toBeCloseTo(expected[k], 6));
    expect(account.balance).toBeCloseTo(1_000_000 + expected.reduce((a, b) => a + b, 0), 6);
  });
});

describe('EasyOrder のロット（総当たりと比べる）', () => {
  it('損失が許容額以下になる最大のロット（0.01 刻み）', () => {
    const r = rng(9);
    for (let n = 0; n < 300; n++) {
      const entry = 140 + r() * 20;
      const sl = entry - (0.05 + r() * 1.5) * (r() < 0.5 ? 1 : -1);
      const riskJpy = 1000 + r() * 50_000;
      const rate = r() < 0.5 ? 1 : 150;
      let best = 0;
      for (let k = 1; k <= 100_000; k++) {
        if (lossAt(k / 100, entry, sl, 100_000, rate) <= riskJpy + 1e-6) best = k / 100;
        else break;
      }
      expect(lotsForRisk({ riskJpy, entry, sl, contract: 100_000, rate })).toBeCloseTo(best, 9);
    }
  });
});

describe('成績（素直な計算と比べる）', () => {
  it('勝率・プロフィットファクター・最大ドローダウン・連勝連敗', () => {
    const r = rng(21);
    const list: TradeRecord[] = Array.from({ length: 200 }, (_, i) => {
      const profit = Math.round((r() - 0.45) * 10_000);
      return {
        ticket: i,
        side: 'buy',
        lots: 0.1,
        openTime: i * 3_600_000,
        closeTime: i * 3_600_000 + 1_800_000,
        openPrice: 150,
        closePrice: 150 + profit / 1000,
        sl: null,
        tp: null,
        profit,
        pips: profit / 100,
        reason: 'manual',
        mae: null,
        mfe: null,
      };
    });
    const s = summarize(list, 1_000_000, 0.01);
    const wins = list.filter((t) => t.profit > 0);
    const losses = list.filter((t) => t.profit < 0);
    expect(s.winRate).toBeCloseTo((wins.length / list.length) * 100, 9);
    expect(s.profitFactor).toBeCloseTo(wins.reduce((a, t) => a + t.profit, 0) / -losses.reduce((a, t) => a + t.profit, 0), 9);
    // 最大ドローダウン: すべての「山 → その後の谷」の差の最大
    const bal = [1_000_000];
    for (const t of list) bal.push(bal[bal.length - 1] + t.profit);
    let dd = 0;
    for (let i = 0; i < bal.length; i++) for (let j = i; j < bal.length; j++) dd = Math.max(dd, bal[i] - bal[j]);
    expect(s.maxDrawdown).toBeCloseTo(dd, 6);
    // 連勝・連敗: 符号の並びで一番長い連続
    const longest = (sign: number) => {
      let best = 0;
      let cur = 0;
      for (const t of list) {
        if (Math.sign(t.profit) === sign) best = Math.max(best, ++cur);
        else if (t.profit !== 0) cur = 0;
      }
      return best;
    };
    expect(s.maxConsecWins).toBe(longest(1));
    expect(s.maxConsecLosses).toBe(longest(-1));
  });
});
