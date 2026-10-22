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

/**
 * 1 か月分。TitanFX の足がある期間（from〜to）は TitanFX だけを使い、その外は Dukascopy を使う
 * （R2: MT4 の取引はブローカー自身の足で再現する）
 */
export function mergeSources(duka: PriceBars, titan: PriceBars, info: Pick<TitanInfo, 'from' | 'to'>): PriceBars {
  const bid: PriceBars['bid'] = [];
  const ask: PriceBars['ask'] = [];
  let j = 0;
  const pushDuka = (until: number) => {
    for (; j < duka.bid.length && duka.bid[j].t < until; j++) {
      const t = duka.bid[j].t;
      if (t >= info.from && t <= info.to) continue;
      bid.push(duka.bid[j]);
      ask.push(duka.ask[j]);
    }
  };
  for (let i = 0; i < titan.bid.length; i++) {
    pushDuka(titan.bid[i].t);
    if (j < duka.bid.length && duka.bid[j].t === titan.bid[i].t) j++;
    bid.push(titan.bid[i]);
    ask.push(titan.ask[i]);
  }
  pushDuka(Infinity);
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
