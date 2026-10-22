// Dukascopy のサイトから手動でダウンロードした 1 分足の CSV（か .hst）を、アプリ用の月ごとのファイルに変換する。
//
//   npm run import-data                                   既定のフォルダ（下の DEFAULT_DIR）を読む
//   npm run import-data -- /path/to/folder                フォルダを指定
//   npm run import-data -- --all                          前回から変わっていない銘柄も読み直す
//
// ファイル名は Dukascopy の既定のまま（例: "USDJPY_1 Min_Bid_2026.10.19_2026.10.21.csv"）。
// 同じ銘柄の Bid と Ask を両方置くこと（Ask が欠けた時刻の足は Bid だけで保存する）。期間を分けた複数のファイルがあってもまとめて読む。
// 銘柄ごとに、その銘柄のファイル（名前・大きさ・更新日時）が前回と同じなら飛ばす（public/data/.imported.json に覚える）。
// ファイルを足したり置き換えたりした銘柄だけ、その銘柄のすべてのファイルから作り直す。
// CSV の形式: "Time (UTC),Open,High,Low,Close,Volume"、時刻は "2026.10.21 00:00:00"（UTC）。日.月.年 の並びも読む
// .hst（MT4 のヒストリー形式。Dukascopy で「MT4 (.hst)」を選んで書き出したもの）も読む（例: "XAUUSD_1 Min_Bid_2010.01.01_2026.01.31.hst"。時刻は GMT で書き出すこと）

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { encodeMonth } from './lib/binfmt.mjs';
import { parseDukascopyRow } from './lib/dukascopy-csv.mjs';
import { parseHst } from './lib/hst.mjs';

const DEFAULT_DIR = '/Volumes/Clucial_1TB/claude/dukascopy';
const DATA_DIR = path.resolve('public/data');
const MANIFEST = path.join(DATA_DIR, 'manifest.json');

/** 銘柄と価格の小数桁数 */
const SYMBOLS = {
  usdjpy: 3,
  eurusd: 5,
  gbpusd: 5,
  audusd: 5,
  usdchf: 5,
  usdcad: 5,
  nzdusd: 5,
  eurjpy: 3,
  gbpjpy: 3,
  xauusd: 3,
};

const FILE_RE = /^([A-Z]+)_1 Min_(Bid|Ask)_.*\.(csv|hst)$/i;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * CSV を読み、月ごとに { 時刻: [t, o, h, l, c] } へ入れる。
 * 出来高 0 の足（値動きの無い時間に Dukascopy が埋める足）は捨てる。
 */
/** .hst（MT4 のヒストリー形式。Dukascopy は 1 分足をこの形でも書き出せる）を読む。出来高 0 の足は CSV と同じく捨てる */
async function readHst(file, byMonth) {
  const { period, bars } = parseHst(await readFile(file));
  if (period !== 1) throw new Error(`${path.basename(file)} は 1 分足ではありません（時間足 ${period} 分）`);
  let n = 0;
  for (const [time, o, h, l, c, vol] of bars) {
    if (vol === 0 || !(h >= l)) continue;
    const key = new Date(time).toISOString().slice(0, 7);
    let m = byMonth.get(key);
    if (!m) byMonth.set(key, (m = new Map()));
    m.set(time, [time, o, h, l, c]);
    n++;
  }
  return n;
}

async function readCsv(file, byMonth) {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  let bad = 0;
  let first = true;
  for await (const line of lines) {
    const row = parseDukascopyRow(line);
    if (!row) {
      // 1 行目（見出し）以外で読めない行は数えて知らせる
      if (!first && line.trim()) bad++;
      first = false;
      continue;
    }
    first = false;
    const [time, o, h, l, c, vol] = row;
    if (vol === 0) continue;
    const key = new Date(time).toISOString().slice(0, 7);
    let m = byMonth.get(key);
    if (!m) byMonth.set(key, (m = new Map()));
    m.set(time, [time, o, h, l, c]);
    n++;
  }
  if (bad) console.log(`  ${path.basename(file)}: 読めない行が ${bad} 行あったので飛ばしました`);
  return n;
}

const IMPORTED = path.join(DATA_DIR, '.imported.json');

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const dir = args.find((a) => !a.startsWith('--')) ?? DEFAULT_DIR;
  if (!(await exists(dir))) throw new Error(`フォルダが見つかりません: ${dir}（外付け SSD はつながっていますか？）`);

  // 銘柄ごとのファイルと、その目印（名前・大きさ・更新日時）
  /** @type {Map<string, { files: { name: string, side: string, ext: string }[], sig: string[] }>} */
  const bySymbol = new Map();
  for (const name of (await readdir(dir)).sort()) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const sym = m[1].toLowerCase();
    if (!(sym in SYMBOLS)) {
      console.log(`${name}: 未対応の銘柄なので飛ばします`);
      continue;
    }
    const st = await stat(path.join(dir, name));
    if (!bySymbol.has(sym)) bySymbol.set(sym, { files: [], sig: [] });
    bySymbol.get(sym).files.push({ name, side: m[2].toLowerCase(), ext: m[3].toLowerCase() });
    bySymbol.get(sym).sig.push(`${name}|${st.size}|${Math.round(st.mtimeMs)}`);
  }
  if (bySymbol.size === 0) throw new Error(`${dir} に Dukascopy の CSV（.hst）がありません`);

  const imported = (await exists(IMPORTED)) ? JSON.parse(await readFile(IMPORTED, 'utf8')) : {};
  const before = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : { symbols: {} };
  /** 銘柄 → { bid: 月 → Map, ask: 月 → Map } */
  const data = new Map();
  for (const [sym, { files, sig }] of bySymbol) {
    const key = sig.join('\n');
    if (!all && imported[sym] === key && before.symbols[sym]?.months?.length) {
      console.log(`${sym.toUpperCase()}: 前回から変わっていないので飛ばします（読み直すときは npm run import-data -- --all）`);
      continue;
    }
    data.set(sym, { bid: new Map(), ask: new Map(), sig: key });
    for (const f of files) {
      const read = f.ext === 'hst' ? readHst : readCsv;
      const n = await read(path.join(dir, f.name), data.get(sym)[f.side]);
      console.log(`${f.name}: ${n.toLocaleString()} 本`);
    }
  }
  if (data.size === 0) {
    console.log('読み込む銘柄はありませんでした');
    return;
  }

  // 開発サーバーが TitanFX の足を同時に書いていることがあるので、書く直前に読み直す
  const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : { symbols: {} };
  for (const [sym, { bid, ask }] of data) {
    const digits = SYMBOLS[sym];
    const outDir = path.join(DATA_DIR, sym);
    await mkdir(outDir, { recursive: true });
    const entry = (manifest.symbols[sym] ??= { digits, months: [] });

    for (const key of [...bid.keys()].sort()) {
      const b = [...bid.get(key).values()].sort((x, y) => x[0] - y[0]);
      const a = [...(ask.get(key)?.values() ?? [])];
      const askTimes = new Set(a.map((r) => r[0]));
      const missing = b.filter((r) => !askTimes.has(r[0])).length;
      await writeFile(path.join(outDir, `${key}.bin`), encodeMonth(b, a, digits));
      if (!entry.months.includes(key)) entry.months.push(key);
      entry.months.sort();
      // Ask は固定スプレッドの検証では使わないので、Ask の CSV を置いていなければ何も言わない
      const note = missing && ask.size ? `（うち Ask が無い足 ${missing.toLocaleString()} 本。後日ダウンロードし直すと埋まることがある）` : '';
      console.log(`${sym} ${key}: ${b.length.toLocaleString()} 本を保存${note}`);
    }
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
  for (const [sym, { sig }] of data) imported[sym] = sig;
  await writeFile(IMPORTED, JSON.stringify(imported, null, 2));
  console.log('完了');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
