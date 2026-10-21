// 3 回目の見直しで足した突き合わせ（crosscheck.test.ts で見ていなかった所）

import { describe, expect, it } from 'vitest';
// @ts-expect-error 型定義のない .mjs
import { parseDukascopyRow, parseDukascopyTime } from '../scripts/lib/dukascopy-csv.mjs';
import { TimeMapper } from '../src/chart/mapper';
import { aggregateWithIndex, mergeBars, type Bar } from '../src/core/candles';
import { formatMoney } from '../src/core/format';
import { symbolSpec } from '../src/core/symbols';
import { serverToUtc, utcToServer, type ServerTimeRule } from '../src/core/time';
import { Account, type Baseline, type PriceFeed } from '../src/trade/account';
import { analyze, excursionOf, type TradeRecord } from '../src/trade/analysis';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('Dukascopy の CSV の読み込み', () => {
  it('年.月.日・日.月.年・ミリ秒付き・ハイフン区切りのどれでも同じ時刻になる', () => {
    const t = Date.UTC(2026, 9, 21, 13, 5);
    for (const s of ['2026.10.21 13:05:00', '2026.10.21 13:05:00.000', '21.10.2026 13:05:00.000', '2026-10-21 13:05:00']) {
      expect(parseDukascopyTime(s)).toBe(t);
    }
    expect(Number.isNaN(parseDukascopyTime('Time (UTC)'))).toBe(true);
  });

  it('見出し・壊れた行（高値 < 安値、数字でない）は読まない', () => {
    expect(parseDukascopyRow('Time (UTC),Open,High,Low,Close,Volume ')).toBeNull();
    expect(parseDukascopyRow('2026.10.21 13:05:00,158.1,158.0,158.2,158.1,1')).toBeNull();
    expect(parseDukascopyRow('2026.10.21 13:05:00,x,158.2,158.0,158.1,1')).toBeNull();
    expect(parseDukascopyRow('2026.10.21 13:05:30,158.1,158.2,158.0,158.15,12.5')).toEqual([Date.UTC(2026, 9, 21, 13, 5), 158.1, 158.2, 158.0, 158.15, 12.5]);
  });
});

describe('MAE・MFE（素直な計算と比べる）', () => {
  // 1 分足の中も 4 点（始値→安値→高値→終値 など）しか無いとみなした値動きで、建値より後の最安・最高を数える
  it('成行（足の終値で約定）は、建てた足の値動きを含めない', () => {
    const bid = [
      { h: 150.5, l: 149.0, c: 150.0 }, // 建てた足: 安値 149.0 は約定より前
      { h: 150.3, l: 149.8, c: 150.1 },
      { h: 150.4, l: 149.9, c: 150.2 },
    ];
    const ask = bid.map((b) => ({ h: b.h + 0.004, l: b.l + 0.004, c: b.c + 0.004 }));
    // 買い: 建値は 1 本目の Ask 終値 150.004、決済は 3 本目の Bid 終値 150.2
    const r = excursionOf(bid, ask, 0, 2, 'buy', 150.004, 150.2, 0.01);
    expect(r.mae).toBeCloseTo((149.8 - 150.004) / 0.01); // 2 本目の安値
    expect(r.mfe).toBeCloseTo((150.4 - 150.004) / 0.01); // 3 本目の高値
  });

  it('含み損は 0 以下・含み益は 0 以上、同じ足で終わった取引は決済の値幅だけ', () => {
    const r = rng(3);
    for (let n = 0; n < 200; n++) {
      const len = 1 + Math.floor(r() * 5);
      const bid = Array.from({ length: len }, () => {
        const c = 150 + (r() - 0.5);
        return { h: c + r() * 0.2, l: c - r() * 0.2, c };
      });
      const ask = bid.map((b) => ({ h: b.h + 0.004, l: b.l + 0.004, c: b.c + 0.004 }));
      const side = r() < 0.5 ? 'buy' : 'sell';
      const open = 150 + (r() - 0.5) * 0.3;
      const close = 150 + (r() - 0.5) * 0.3;
      const x = excursionOf(bid, ask, 0, len - 1, side, open, close, 0.01);
      const done = ((close - open) * (side === 'buy' ? 1 : -1)) / 0.01;
      expect(x.mae).toBeLessThanOrEqual(0);
      expect(x.mfe).toBeGreaterThanOrEqual(0);
      expect(x.mae).toBeLessThanOrEqual(Math.min(0, done) + 1e-9);
      expect(x.mfe).toBeGreaterThanOrEqual(Math.max(0, done) - 1e-9);
      if (len === 1) expect([x.mae, x.mfe]).toEqual([Math.min(0, done), Math.max(0, done)]);
    }
  });
});

describe('時刻の変換（往復）', () => {
  const ny: ServerTimeRule = { kind: 'ny-close' };
  it('UTC → サーバー時刻 → UTC が 2 年間の平日すべてで元に戻る（夏時間の切り替えを含む）', () => {
    // 夏時間が終わる日曜の朝だけ、同じサーバー時刻が 2 回ある（市場は休みなので価格も取引も無い）
    const bad: string[] = [];
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2027, 0, 1); t += 15 * 60_000) {
      if (serverToUtc(utcToServer(t, ny), ny) === t) continue;
      const day = new Date(utcToServer(t, ny)).getUTCDay();
      if (day !== 0 && day !== 6) bad.push(new Date(t).toISOString());
    }
    expect(bad).toEqual([]);
  });

  it('サーバー時刻は夏 UTC+3・冬 UTC+2（米国の夏時間）', () => {
    expect(utcToServer(Date.UTC(2026, 6, 1), ny) - Date.UTC(2026, 6, 1)).toBe(3 * 3_600_000);
    expect(utcToServer(Date.UTC(2026, 0, 15), ny) - Date.UTC(2026, 0, 15)).toBe(2 * 3_600_000);
    // 2026 年の米国の夏時間は 11/1 に終わる（欧州は 10/25）
    expect(utcToServer(Date.UTC(2026, 9, 28), ny) - Date.UTC(2026, 9, 28)).toBe(3 * 3_600_000);
    expect(utcToServer(Date.UTC(2026, 10, 3), ny) - Date.UTC(2026, 10, 3)).toBe(2 * 3_600_000);
  });
});

describe('チャートの位置（時刻 ⇔ 足の番号）', () => {
  it('足の時刻・足と足の間・未来の時刻のどれも、往復すると元に戻る', () => {
    const H = 3_600_000;
    // 1 時間足。途中に週末（48 時間の空白）がある
    const times = [0, 1, 2, 3, 51, 52, 53].map((h) => h * H);
    for (const offset of [0, 2]) {
      const m = new TimeMapper(times, H, offset);
      for (const t of [...times, 0.5 * H, 2.25 * H, 51.75 * H, 60 * H]) expect(m.toTime(m.toLogical(t))).toBeCloseTo(t, 3);
    }
  });
});

describe('円以外の決済通貨（EURUSD）', () => {
  it('損益 = 値幅 × 数量 × USDJPY、証拠金 = 数量 × 価格 × USDJPY ÷ レバレッジ', () => {
    const spec = symbolSpec('eurusd', 5);
    const bar = (p: number) => ({ t: 0, o: p, h: p, l: p, c: p });
    const feed: PriceFeed = { bid: [bar(1.1), bar(1.102)], ask: [bar(1.10002), bar(1.10022)], jpyRate: () => 150 };
    const baseline: Baseline = { time: 0, balance: 1_000_000, history: [], nextTicket: 1 };
    const a = new Account(spec, { leverage: 25 }, baseline);
    a.apply(feed, 0, { t: 0, kind: 'market', side: 'buy', lots: 1, sl: null, tp: null });
    expect(a.summary(feed, 0).margin).toBeCloseTo((100_000 * 1.10002 * 150) / 25, 6);
    a.apply(feed, 1, { t: 0, kind: 'close', ticket: 1 });
    // (1.10200 - 1.10002) × 100,000 × 150 = 29,700 円
    expect(a.balance).toBeCloseTo(1_000_000 + (1.102 - 1.10002) * 100_000 * 150, 6);
  });
});

describe('成績の内訳', () => {
  it('曜日・時間帯・時刻・保有時間・月・pips の分布は、どれも合計すると全体と同じ', () => {
    const r = rng(8);
    const list: TradeRecord[] = Array.from({ length: 300 }, (_, i) => {
      const openTime = Date.UTC(2026, 0, 1) + Math.floor(r() * 300 * 86_400_000);
      const pips = (r() - 0.5) * 140;
      return {
        ticket: i,
        side: r() < 0.5 ? 'buy' : 'sell',
        lots: 0.1,
        openTime,
        closeTime: openTime + Math.floor(r() * 3 * 86_400_000),
        openPrice: 150,
        closePrice: 150 + pips / 100,
        sl: null,
        tp: null,
        profit: Math.round(pips * 100),
        pips,
        reason: 'manual',
        mae: null,
        mfe: null,
      };
    });
    const a = analyze(list, 1_000_000, 0.01, (t) => t + 9 * 3_600_000);
    const total = list.reduce((s, t) => s + t.profit, 0);
    for (const bs of [a.byWeekday, a.byHour, a.bySession, a.byMonth, a.byHold, a.pipsHistogram]) {
      expect(bs.reduce((s, b) => s + b.trades, 0)).toBe(list.length);
      expect(bs.reduce((s, b) => s + b.net, 0)).toBeCloseTo(total, 6);
    }
    expect(a.long.trades + a.short.trades).toBe(list.length);
    expect(a.long.net + a.short.net).toBeCloseTo(a.summary.net, 6);
    expect(a.equity.at(-1)!.balance).toBeCloseTo(1_000_000 + total, 6);
  });
});

describe('作りかけの足', () => {
  it('期間の最後の 1 分足まで来た作りかけの足は、確定した足と同じ', () => {
    const ny: ServerTimeRule = { kind: 'ny-close' };
    const r = rng(4);
    const m1: Bar[] = Array.from({ length: 2000 }, (_, i) => {
      const c = 150 + (r() - 0.5);
      return { t: Date.UTC(2026, 9, 19) + i * 60_000, o: c, h: c + r() * 0.1, l: c - r() * 0.1, c };
    });
    const { bars, starts } = aggregateWithIndex(m1, 'H1', ny);
    for (let k = 0; k + 1 < bars.length; k++) expect(mergeBars(m1, starts[k], starts[k + 1] - 1, bars[k].t)).toEqual(bars[k]);
  });
});

describe('金額の表示', () => {
  it('丸めて 0 になる小さなマイナスは「-0」ではなく「0」', () => {
    expect(formatMoney(-0.4)).toBe('0');
    expect(formatMoney(-1234.6)).toBe('-1,235');
  });
});
