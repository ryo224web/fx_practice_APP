// Dukascopy から 1 分足（Bid と Ask）を取得し、月ごとのファイルに保存する。
//
//   npm run fetch-data                                  USDJPY の直近 1 年
//   npm run fetch-data -- eurusd xauusd                 銘柄を指定
//   npm run fetch-data -- usdjpy --from 2010-01-01      期間を指定（--to も可、既定は今日）
//   npm run fetch-data -- all                           主要通貨 + GOLD をすべて
//
// 取得済みの月は飛ばすので、途中で止めても再実行すれば続きから始まる（今月だけは毎回取り直す）。

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { getHistoricalRates } from 'dukascopy-node';
import { encodeMonth } from './lib/binfmt.mjs';

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

const DATA_DIR = path.resolve('public/data');
const MANIFEST = path.join(DATA_DIR, 'manifest.json');

function parseArgs(argv) {
  const symbols = [];
  let from;
  let to;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === 'all') symbols.push(...Object.keys(SYMBOLS));
    else symbols.push(a.toLowerCase());
  }
  const today = new Date();
  const toDate = to ? new Date(to + 'T00:00:00Z') : today;
  const fromDate = from
    ? new Date(from + 'T00:00:00Z')
    : new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1));
  for (const s of symbols) {
    if (!(s in SYMBOLS)) throw new Error(`未対応の銘柄: ${s}（対応: ${Object.keys(SYMBOLS).join(', ')}）`);
  }
  return { symbols: symbols.length ? [...new Set(symbols)] : ['usdjpy'], fromDate, toDate };
}

/** [月初, 翌月初) の UTC の組を返す */
function months(fromDate, toDate) {
  const out = [];
  let y = fromDate.getUTCFullYear();
  let m = fromDate.getUTCMonth();
  while (Date.UTC(y, m, 1) <= toDate.getTime()) {
    out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) });
    if (++m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchSide(instrument, from, to, priceType) {
  return getHistoricalRates({
    instrument,
    dates: { from, to: to > new Date() ? new Date() : to },
    timeframe: 'm1',
    priceType,
    format: 'array',
    ignoreFlats: true,
    useCache: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 500,
    retryCount: 3,
  });
}

async function main() {
  const { symbols, fromDate, toDate } = parseArgs(process.argv.slice(2));
  const manifest = (await exists(MANIFEST)) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : { symbols: {} };
  const currentKey = new Date().toISOString().slice(0, 7);

  for (const sym of symbols) {
    const digits = SYMBOLS[sym];
    const dir = path.join(DATA_DIR, sym);
    await mkdir(dir, { recursive: true });
    const entry = (manifest.symbols[sym] ??= { digits, months: [] });

    for (const mo of months(fromDate, toDate)) {
      const file = path.join(dir, `${mo.key}.bin`);
      if (mo.key !== currentKey && (await exists(file))) {
        console.log(`${sym} ${mo.key} 取得済み`);
        continue;
      }
      const t0 = Date.now();
      const [bid, ask] = await Promise.all([fetchSide(sym, mo.from, mo.to, 'bid'), fetchSide(sym, mo.from, mo.to, 'ask')]);
      if (bid.length === 0) {
        console.log(`${sym} ${mo.key} データなし`);
        continue;
      }
      await writeFile(file, encodeMonth(bid, ask, digits));
      if (!entry.months.includes(mo.key)) entry.months.push(mo.key);
      entry.months.sort();
      await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
      console.log(`${sym} ${mo.key} ${bid.length.toLocaleString()} 本 (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
    }
  }
  console.log('完了');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
