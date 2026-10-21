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
