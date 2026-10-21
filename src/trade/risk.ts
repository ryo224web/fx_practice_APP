// EasyOrder と同じ考え方で、損切りまでの値幅と許容する損失からロット数を決める。

export interface RiskInput {
  /** 許容する損失（円） */
  riskJpy: number;
  entry: number;
  sl: number;
  /** 1 ロットあたりの数量 */
  contract: number;
  /** 決済通貨 → 円 */
  rate: number;
  /** ロットの刻み（MT4 の多くの口座は 0.01） */
  step?: number;
}

/** 損切りに掛かったときの損失が riskJpy を超えない最大のロット数。0 なら最小ロットでも超える */
export function lotsForRisk({ riskJpy, entry, sl, contract, rate, step = 0.01 }: RiskInput): number {
  const perLot = Math.abs(entry - sl) * contract * rate;
  if (!(perLot > 0) || !(riskJpy > 0)) return 0;
  const n = Math.floor(riskJpy / perLot / step + 1e-9);
  return Math.round(n * step * 100) / 100;
}

/** ロット数と値幅から、損切りに掛かったときの損失（円） */
export function lossAt(lots: number, entry: number, sl: number, contract: number, rate: number): number {
  return Math.abs(entry - sl) * lots * contract * rate;
}
