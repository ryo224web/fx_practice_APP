import { decodeMonth, type PriceBars } from '../core/binfmt';

/** TitanFX（MT4 から書き出した 1 分足）の範囲。server/mt4Bars.ts が書く */
export interface TitanInfo {
  months: string[];
  /** 最初と最後の足の時刻（UTC） */
  from: number;
  to: number;
}

export interface Manifest {
  symbols: Record<string, { digits: number; months: string[]; titan?: TitanInfo }>;
}

/** 読み込んだ一覧（loadMonths が TitanFX の足の有無を見るのに使う） */
let current: Manifest | null = null;

/** npm run import-data で作られる一覧。まだ無ければ null */
export async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch('/data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    current = (await res.json()) as Manifest;
    return current;
  } catch {
    return null;
  }
}

async function fetchMonth(url: string, digits: number, required: boolean): Promise<PriceBars> {
  // TitanFX の月は書き足されていくので、古い控えを使わない
  const res = await fetch(url, { cache: 'no-cache' });
  // 無いファイルは、開発サーバーが 404 ではなくページ（HTML）を返すことがある
  if (res.ok && !res.headers.get('content-type')?.includes('text/html')) return decodeMonth(await res.arrayBuffer(), digits);
  if (required) throw new Error(`${url} の読み込みに失敗 (${res.status})`);
  return { bid: [], ask: [] };
}

/** TitanFX の足がこれより長く空いていたら、そこは MT4 に足が無かった（週末・年末年始の休みより長い） */
export const TITAN_GAP = 72 * 3_600_000;

/**
 * 1 か月分。TitanFX の足がある所は TitanFX だけを使い、無い所は Dukascopy を使う
 * （R2: MT4 の取引はブローカー自身の足で再現する）。
 * Dukascopy の足を捨てるのは、TitanFX の範囲（from〜to）の中で、前後の TitanFX の足との間が TITAN_GAP 以内のときだけ
 * （MT4 が途中の月の足を持っていなかったときに、チャートが抜けないように）
 */
export function mergeSources(duka: PriceBars, titan: PriceBars, info: Pick<TitanInfo, 'from' | 'to'>): PriceBars {
  const bid: PriceBars['bid'] = [];
  const ask: PriceBars['ask'] = [];
  const tb = titan.bid;
  let i = 0;
  let j = 0;
  /** t の前後の TitanFX の足（i は t 以上で最初の足） */
  const covered = (t: number) => {
    if (t < info.from || t > info.to) return false;
    const prev = i > 0 ? tb[i - 1].t : null;
    const next = i < tb.length ? tb[i].t : null;
    if (prev !== null && next !== null) return next - prev <= TITAN_GAP;
    if (next !== null) return next - t <= TITAN_GAP;
    if (prev !== null) return t - prev <= TITAN_GAP;
    return false;
  };
  while (i < tb.length || j < duka.bid.length) {
    const td = j < duka.bid.length ? duka.bid[j].t : Infinity;
    const tt = i < tb.length ? tb[i].t : Infinity;
    if (tt <= td) {
      if (td === tt) j++; // 同じ時刻は TitanFX
      bid.push(tb[i]);
      ask.push(titan.ask[i]);
      i++;
    } else {
      if (!covered(td)) {
        bid.push(duka.bid[j]);
        ask.push(duka.ask[j]);
      }
      j++;
    }
  }
  return { bid, ask };
}

async function loadMonth(symbol: string, m: string, digits: number): Promise<PriceBars> {
  const titan = current?.symbols[symbol]?.titan;
  if (!titan?.months.includes(m)) return fetchMonth(`/data/${symbol}/${m}.bin`, digits, true);
  // Dukascopy の無い月（TitanFX だけの直近の月）もある
  const [d, t] = await Promise.all([fetchMonth(`/data/${symbol}/${m}.bin`, digits, false), fetchMonth(`/data/${symbol}/titan/${m}.bin`, digits, true)]);
  return mergeSources(d, t, titan);
}

/** 指定した月をまとめて読み込み、時刻順につないで返す */
export async function loadMonths(symbol: string, months: string[], digits: number): Promise<PriceBars> {
  const parts = await Promise.all(months.map((m) => loadMonth(symbol, m, digits)));
  return { bid: parts.flatMap((p) => p.bid), ask: parts.flatMap((p) => p.ask) };
}
