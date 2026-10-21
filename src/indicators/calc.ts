// インジケーターの計算。どれも「その足までの終値」だけを使うので、リプレイで未来の値が混ざることはない。

/** 単純移動平均。先頭の period-1 本は NaN */
export function sma(closes: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(closes.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移動平均（MT4 と同じく、最初の値は単純移動平均から始める） */
export function ema(closes: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) out[i] = out[i - 1] + k * (closes[i] - out[i - 1]);
  return out;
}

/** 最後の値だけを差し替えたときの EMA（作りかけの足用） */
export function emaNext(prev: number, close: number, period: number): number {
  return prev + (2 / (period + 1)) * (close - prev);
}

/**
 * RCI（順位相関指数）。closes[end-period+1..end] で計算し、-100〜100 を返す。
 * 日付の順位は新しい足を 1 位、価格の順位は高い方を 1 位とする（同値は平均順位）。
 */
export function rciAt(closes: ArrayLike<number>, end: number, period: number, last = closes[end]): number {
  if (end - period + 1 < 0) return NaN;
  const vals: number[] = new Array(period);
  for (let j = 0; j < period; j++) vals[j] = j === 0 ? last : closes[end - j];
  // vals[j] の日付順位は j+1
  const order = vals.map((_, j) => j).sort((a, b) => vals[b] - vals[a]);
  const rank = new Array<number>(period);
  for (let r = 0; r < period; ) {
    let s = r;
    while (s + 1 < period && vals[order[s + 1]] === vals[order[r]]) s++;
    const avg = (r + s) / 2 + 1;
    for (let q = r; q <= s; q++) rank[order[q]] = avg;
    r = s + 1;
  }
  let d2 = 0;
  for (let j = 0; j < period; j++) d2 += (j + 1 - rank[j]) ** 2;
  return (1 - (6 * d2) / (period * (period * period - 1))) * 100;
}
