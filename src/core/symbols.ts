// 銘柄ごとの取引条件。口座通貨は円。

export interface SymbolSpec {
  name: string;
  digits: number;
  /** 1 ロットあたりの数量（通貨は 10 万通貨、GOLD は 100 オンス） */
  contract: number;
  /** 決済通貨（損益の通貨）。USDJPY なら JPY */
  quote: string;
  /** 1 pip の値幅 */
  pip: number;
}

/**
 * 新しい検証で使う固定スプレッドの初期値（pips）。目安なので、検証を始めるときに自分のブローカーに合わせて変える。
 * GOLD の 1 pip は 0.1 ドル
 */
export const DEFAULT_SPREAD_PIPS: Record<string, number> = {
  usdjpy: 0.3,
  eurusd: 0.3,
  gbpusd: 0.6,
  audusd: 0.5,
  usdchf: 0.6,
  usdcad: 0.6,
  nzdusd: 0.8,
  eurjpy: 0.6,
  gbpjpy: 1.0,
  xauusd: 2.0,
};

export function symbolSpec(symbol: string, digits: number): SymbolSpec {
  const s = symbol.toUpperCase();
  const gold = s.startsWith('XAU');
  return {
    name: s,
    digits,
    contract: gold ? 100 : 100_000,
    quote: s.slice(3, 6),
    pip: gold ? 0.1 : digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits,
  };
}
