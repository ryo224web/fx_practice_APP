import { decodeMonth, type PriceBars } from '../core/binfmt';

export interface Manifest {
  symbols: Record<string, { digits: number; months: string[] }>;
}

/** npm run fetch-data で作られる一覧。まだ無ければ null */
export async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch('/data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

/** 指定した月をまとめて読み込み、時刻順につないで返す */
export async function loadMonths(symbol: string, months: string[], digits: number): Promise<PriceBars> {
  const parts = await Promise.all(
    months.map(async (m) => {
      const res = await fetch(`/data/${symbol}/${m}.bin`);
      if (!res.ok) throw new Error(`${symbol} ${m} の読み込みに失敗 (${res.status})`);
      return decodeMonth(await res.arrayBuffer(), digits);
    }),
  );
  return { bid: parts.flatMap((p) => p.bid), ask: parts.flatMap((p) => p.ask) };
}
