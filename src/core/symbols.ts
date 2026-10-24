// 銘柄ごとの取引条件。口座通貨は円。

export interface SymbolSpec {
  name: string;
  digits: number;
  /** 1 ロットあたりの数量（通貨は 10 万通貨、GOLD は 100 オンス、BTCUSD は 1 BTC、JP225 は 100 倍） */
  contract: number;
  /** 決済通貨（損益の通貨）。USDJPY なら JPY、JP225 も JPY */
  quote: string;
  /** 1 pip の値幅 */
  pip: number;
  /** ロットの刻み（最小ロットも同じ）。多くは 0.01、TitanFX の JPN225 は 0.1 */
  lotStep: number;
}

/**
 * 新しい検証で使う固定スプレッドの初期値（pips）。目安なので、検証を始めるときに自分のブローカーに合わせて変える。
 * GOLD・BTCUSD の 1 pip は 0.1 ドル（BTCUSD は 2026-10-24 の TitanFX で 22.48 ドル = 224.8 pips）。JP225 の 1 pip は 1 円（同じ日に 8.0 円）
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
  btcusd: 225,
  jp225: 8,
};

export function symbolSpec(symbol: string, digits: number): SymbolSpec {
  const s = symbol.toUpperCase();
  const gold = s.startsWith('XAU');
  // TitanFX の BTCUSD: 小数 2 桁・契約サイズ 1（1 ロット = 1 BTC）。1 pip は MT4 のスプレッド表示に合わせて 0.1 ドル
  const btc = s.startsWith('BTC');
  // TitanFX の JPN225（アプリでは JP225）: 小数 1 桁・契約サイズ 100・損益は円。1 pip は 1 円（10 ポイント。BTCUSD と同じ数え方）
  if (s === 'JP225') return { name: s, digits, contract: 100, quote: 'JPY', pip: 1, lotStep: 0.1 };
  return {
    name: s,
    digits,
    contract: gold ? 100 : btc ? 1 : 100_000,
    quote: s.slice(3, 6),
    pip: gold || btc ? 0.1 : digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits,
    lotStep: 0.01,
  };
}
