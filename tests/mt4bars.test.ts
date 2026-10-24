// MT4 から書き出した 1 分足の取り込み（server/mt4Bars.ts）と、Dukascopy との合わせ方（src/data/store.ts）

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeMonth } from '../src/core/binfmt';
import { mergeSources } from '../src/data/store';
import { BarsSync, decodeBars, encodeBars, mergeFiles, parseBarCsv, parseBarFileName, rangeUtc, type RawBar } from '../server/mt4Bars';

const H = 3_600_000;
const M = 60_000;

/** サーバー時刻の CSV（start〜、n 本、1 分ごと） */
function dayCsv(serverStart: number, n: number, base: number, step = 0.001) {
  const pad = (v: number) => String(v).padStart(2, '0');
  const rows = ['time,open,high,low,close,volume'];
  for (let i = 0; i < n; i++) {
    const d = new Date(serverStart + i * M);
    const p = base + i * step;
    rows.push(`${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())},${p.toFixed(3)},${(p + 0.01).toFixed(3)},${(p - 0.01).toFixed(3)},${(p + 0.002).toFixed(3)},5`);
  }
  return rows.join('\r\n') + '\r\n';
}

describe('MT4 の 1 分足のファイル', () => {
  it('ファイル名から銘柄と期間（サーバー時刻の月。日ごとも読む）を読む。接尾辞や GOLD も読み替える', () => {
    expect(parseBarFileName('USDJPY_2026.10.csv')).toEqual({ symbol: 'usdjpy', start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1) });
    expect(parseBarFileName('USDJPY_2026.12.csv')?.end).toBe(Date.UTC(2027, 0, 1));
    expect(parseBarFileName('BTCUSD_2026.10.csv')?.symbol).toBe('btcusd');
    expect(parseBarFileName('JPN225_2026.10.csv')?.symbol).toBe('jp225');
    expect(parseBarFileName('USDJPY_2026.10.22.csv')).toEqual({ symbol: 'usdjpy', start: Date.UTC(2026, 9, 22), end: Date.UTC(2026, 9, 23) });
    expect(parseBarFileName('EURUSD.a_2026.10.csv')?.symbol).toBe('eurusd');
    expect(parseBarFileName('GOLD_2026.10.csv')?.symbol).toBe('xauusd');
    expect(parseBarFileName('_status.csv')).toBe(null);
    expect(parseBarFileName('USDJPY_2026.10.csv.tmp')).toBe(null);
    expect(parseBarFileName('ETHUSD_2026.10.csv')).toBe(null);
  });

  it('CSV を読む（見出し・壊れた行は飛ばす）', () => {
    const bars = parseBarCsv('time,open,high,low,close,volume\r\n2026.10.22 00:01,151.2,151.3,151.1,151.25,3\r\nbroken\r\n2026.10.22 00:00,151.1,151.2,151.0,151.2,4\r\n');
    expect(bars).toEqual([
      { t: Date.UTC(2026, 9, 22, 0, 0), o: 151.1, h: 151.2, l: 151.0, c: 151.2 },
      { t: Date.UTC(2026, 9, 22, 0, 1), o: 151.2, h: 151.3, l: 151.1, c: 151.25 },
    ]);
  });

  it('サーバー時刻の 0:00 は NY 17:00（米国の夏時間中は UTC 21:00、冬は 22:00）', () => {
    expect(rangeUtc(Date.UTC(2026, 9, 22), Date.UTC(2026, 9, 23))).toEqual([Date.UTC(2026, 9, 21, 21), Date.UTC(2026, 9, 22, 21)]);
    // 11 月のファイル: UTC 10/31 21:00（夏時間）〜 11/30 22:00（冬時間）
    expect(rangeUtc(Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual([Date.UTC(2026, 9, 31, 21), Date.UTC(2026, 10, 30, 22)]);
  });

  it('保存形式の往復で値が変わらない', () => {
    const bars: RawBar[] = [{ t: Date.UTC(2026, 9, 22, 1, 2), o: 151.234, h: 151.3, l: 151.001, c: 151.25 }];
    expect(decodeBars(encodeBars(bars, 3), 3)).toEqual(bars);
    // Ask は無し（0 = 欠け）
    expect(decodeMonth(encodeBars(bars, 3).slice().buffer, 3).ask).toEqual([null]);
  });

  it('同じ期間をもう一度取り込むと、その期間の足はファイルどおりに置き換わる（ほかの期間は残る）', () => {
    const r1 = rangeUtc(Date.UTC(2026, 9, 21), Date.UTC(2026, 9, 22));
    const r2 = rangeUtc(Date.UTC(2026, 9, 22), Date.UTC(2026, 9, 23));
    const b = (t: number, p: number): RawBar => ({ t, o: p, h: p, l: p, c: p });
    const old = [b(r1[0], 1), b(r1[0] + M, 1), b(r2[0], 2), b(r2[0] + M, 2), b(r2[0] + 2 * M, 2)];
    const merged = mergeFiles(old, [{ range: r2, bars: [b(r2[0], 3), b(r2[0] + M, 3)] }]);
    expect(merged).toEqual([b(r1[0], 1), b(r1[0] + M, 1), b(r2[0], 3), b(r2[0] + M, 3)]);
  });
});

describe('TitanFX と Dukascopy の合わせ方', () => {
  it('MT4 に足が無かった期間（3 日より長い空き）は Dukascopy で埋める', () => {
    const D = 86_400_000;
    const days = [0, 1, 2, 10, 11, 12, 20]; // 3〜9 日目は MT4 に足が無かった
    const duka = { bid: Array.from({ length: 21 }, (_, d) => bar(d * D + 1000, 1)), ask: Array.from({ length: 21 }, () => null) };
    const titan = { bid: days.map((d) => bar(d * D, 2)), ask: days.map(() => null) };
    const m = mergeSources(duka, titan, { from: 0, to: 20 * D });
    const src = (d: number) => m.bid.filter((b) => Math.floor(b.t / D) === d).map((b) => b.c);
    // TitanFX の足の間（1 日空き）は TitanFX だけ
    expect(src(1)).toEqual([2]);
    // 2 日目と 10 日目の間は 8 日空いているので Dukascopy で埋める
    for (const d of [3, 5, 9]) expect(src(d)).toEqual([1]);
    // 12 日目と 20 日目の間も同じ
    expect(src(15)).toEqual([1]);
    expect(m.bid.map((b) => b.t)).toEqual([...m.bid.map((b) => b.t)].sort((a, b) => a - b));
  });

  it('月の初めの数時間だけ TitanFX があるとき（MT4 にその月が無い）、その月は Dukascopy', () => {
    const D = 86_400_000;
    const duka = { bid: Array.from({ length: 30 }, (_, d) => bar(d * D, 1)), ask: Array.from({ length: 30 }, () => null) };
    const titan = { bid: [bar(29 * D + 3_600_000, 2)], ask: [null] };
    const m = mergeSources(duka, titan, { from: 0, to: 40 * D });
    expect(m.bid.filter((b) => b.c === 1).length).toBe(27); // 27〜29 日目の頭（TitanFX の足の 3 日前以内）だけ TitanFX 側
  });

  const bar = (t: number, p: number) => ({ t, o: p, h: p, l: p, c: p });
  it('TitanFX の範囲は TitanFX だけ、その外は Dukascopy', () => {
    const duka = { bid: [0, 1, 2, 3, 4, 5].map((i) => bar(i * M, 1)), ask: [0, 1, 2, 3, 4, 5].map((i) => bar(i * M, 1.1)) };
    // TitanFX は 2〜3 分（3 分目は動きが無くて足が無い）。Dukascopy の 3 分目は使わない
    const titan = { bid: [bar(2 * M, 2), bar(4 * M, 2)], ask: [null, null] };
    const m = mergeSources(duka, titan, { from: 2 * M, to: 4 * M });
    expect(m.bid.map((b) => [b.t / M, b.c])).toEqual([
      [0, 1],
      [1, 1],
      [2, 2],
      [4, 2],
      [5, 1],
    ]);
    expect(m.ask.map((a) => a?.c ?? null)).toEqual([1.1, 1.1, null, null, 1.1]);
  });
});

describe('共有フォルダからの取り込み（BarsSync）', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('月ごとのファイルを UTC の月ごとに保存し、manifest に範囲を書く。書き直した月だけ入れ替わり、消えた月も残る', async () => {
    const shared = await mkdtemp(path.join(os.tmpdir(), 'fxp-bars-'));
    const data = await mkdtemp(path.join(os.tmpdir(), 'fxp-data-'));
    dirs.push(shared, data);
    // 既に Dukascopy の 10 月がある
    await writeFile(path.join(data, 'manifest.json'), JSON.stringify({ symbols: { usdjpy: { digits: 3, months: ['2026-10'] } } }));
    // 10 月のファイル: サーバー 10/30（金）0:00〜 60 本（UTC 10/29 21:00〜。夏時間）
    // 11 月のファイル: サーバー 11/2（月）0:00〜 180 本（UTC 11/1 22:00〜。冬時間）
    // 銘柄ごとのフォルダに置く（EA の書き方）
    await mkdir(path.join(shared, 'USDJPY'));
    await writeFile(path.join(shared, 'USDJPY', 'USDJPY_2026.10.csv'), dayCsv(Date.UTC(2026, 9, 30), 60, 152));
    await writeFile(path.join(shared, 'USDJPY', 'USDJPY_2026.11.csv'), dayCsv(Date.UTC(2026, 10, 2), 180, 153));
    await writeFile(path.join(shared, '_status.csv'), 'server,gmt,offset_sec,company,server_name,exported_until\r\n2026.11.03 00:10:00,2026.11.02 22:10:00,7200,Titan FX,TitanFX-02,2026.11.03\r\n');

    const sync = new BarsSync(shared, data);
    await sync.sync();
    expect(sync.status.error).toBe(null);
    const manifest = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
    const e = manifest.symbols.usdjpy;
    expect(e.months).toEqual(['2026-10', '2026-11']);
    expect(e.titan.months).toEqual(['2026-10', '2026-11']);
    expect(e.titan.from).toBe(Date.UTC(2026, 9, 29, 21)); // サーバー 10/30 0:00（夏時間）
    expect(e.titan.to).toBe(Date.UTC(2026, 10, 1, 22) + 179 * M); // サーバー 11/2 2:59（冬時間）
    const oct = decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-10.bin')), 3);
    const nov = decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-11.bin')), 3);
    expect(oct.length).toBe(60);
    expect(nov.length).toBe(180);
    expect(nov[0].o).toBe(153);
    // MT4 のずれ（GMT+2）とアプリの決まり（11/2 は NY 冬時間 → GMT+2）が合っている
    expect(sync.status.offset).toEqual({ mt4: 120, app: 120, at: Date.UTC(2026, 10, 2, 22, 10) });
    expect(sync.status.latest.usdjpy).toBe(e.titan.to);

    // 次の日: 11 月のファイルが書き直された（足が増え、最初の足も直された）。10 月のファイルは消えた（取り込んだ分は残る）
    await rm(path.join(shared, 'USDJPY', 'USDJPY_2026.10.csv'));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(path.join(shared, 'USDJPY', 'USDJPY_2026.11.csv'), dayCsv(Date.UTC(2026, 10, 2), 1440 + 200, 154));
    await sync.sync();
    const nov2 = decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-11.bin')), 3);
    expect(nov2.length).toBe(1640);
    expect(nov2[0].o).toBe(154);
    expect(decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-10.bin')), 3).length).toBe(60);
    const m2 = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
    expect(m2.symbols.usdjpy.titan.from).toBe(Date.UTC(2026, 9, 29, 21));
    expect(m2.symbols.usdjpy.titan.to).toBe(Date.UTC(2026, 10, 1, 22) + 1639 * M);
  });

  it('サーバー時刻の月の初めの数時間（UTC では前の月）は、UTC の前の月のファイルに入る', async () => {
    const shared = await mkdtemp(path.join(os.tmpdir(), 'fxp-bars-'));
    const data = await mkdtemp(path.join(os.tmpdir(), 'fxp-data-'));
    dirs.push(shared, data);
    // サーバー 2026-12-01（火）0:00〜 = UTC 11/30 22:00〜
    await writeFile(path.join(shared, 'USDJPY_2026.12.csv'), dayCsv(Date.UTC(2026, 11, 1), 240, 150));
    const sync = new BarsSync(shared, data);
    await sync.sync();
    expect(decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-11.bin')), 3).length).toBe(120);
    expect(decodeBars(await readFile(path.join(data, 'usdjpy/titan/2026-12.bin')), 3).length).toBe(120);
    const e = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8')).symbols.usdjpy;
    expect(e.titan.months).toEqual(['2026-11', '2026-12']);
  });

  it('共有フォルダが無くても止まらない', async () => {
    const sync = new BarsSync(path.join(os.tmpdir(), 'fxp-no-such-dir-' + Date.now()), os.tmpdir());
    await sync.sync();
    expect(sync.status.found).toBe(false);
    expect(sync.status.error).toBe(null);
  });
});

void H;
