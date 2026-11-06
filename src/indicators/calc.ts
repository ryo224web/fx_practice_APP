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

/** ZigZag の山・谷（i は足の位置、price はその足の高値か安値） */
export interface ZigzagPoint {
  i: number;
  price: number;
}

/**
 * MT4 の標準の ZigZag（Depth・Deviation・Backstep）と同じ計算。high・low は古い順。
 * deviation は価格の幅（MT4 の Deviation × Point）。from〜to の足だけを使う（to より後の足は見ない）。
 * 最後の山・谷は、その先の足しだいで動く（MT4 と同じく、確定していない）
 */
export function zigzag(high: ArrayLike<number>, low: ArrayLike<number>, from: number, to: number, depth: number, deviation: number, backstep: number): ZigzagPoint[] {
  const n = to - from + 1;
  if (n < depth || depth < 1) return [];
  const hi = new Float64Array(n);
  const lo = new Float64Array(n);
  let lastLow = 0;
  let lastHigh = 0;
  for (let s = depth - 1; s < n; s++) {
    // 安値: この足を含む depth 本の一番安い値
    let val = Infinity;
    for (let q = s - depth + 1; q <= s; q++) val = Math.min(val, low[from + q]);
    if (val === lastLow) val = 0;
    else {
      lastLow = val;
      if (low[from + s] - val > deviation) val = 0;
      else
        for (let b = 1; b <= backstep && s - b >= 0; b++) {
          if (lo[s - b] !== 0 && lo[s - b] > val) lo[s - b] = 0;
        }
    }
    lo[s] = low[from + s] === val ? val : 0;
    // 高値
    val = -Infinity;
    for (let q = s - depth + 1; q <= s; q++) val = Math.max(val, high[from + q]);
    if (val === lastHigh) val = 0;
    else {
      lastHigh = val;
      if (val - high[from + s] > deviation) val = 0;
      else
        for (let b = 1; b <= backstep && s - b >= 0; b++) {
          if (hi[s - b] !== 0 && hi[s - b] < val) hi[s - b] = 0;
        }
    }
    hi[s] = high[from + s] === val ? val : 0;
  }
  // 山と谷が交互になるように選ぶ
  const zz = new Float64Array(n);
  let look = 0;
  let lh = 0;
  let ll = 0;
  let lhPos = -1;
  let llPos = -1;
  for (let s = depth - 1; s < n; s++) {
    if (look === 0) {
      if (ll === 0 && lh === 0) {
        if (hi[s] !== 0) {
          lh = high[from + s];
          lhPos = s;
          look = -1;
          zz[s] = lh;
        }
        if (lo[s] !== 0) {
          ll = low[from + s];
          llPos = s;
          look = 1;
          zz[s] = ll;
        }
      }
    } else if (look === 1) {
      // 谷の後: もっと低い谷なら置き換え、山が来たら山を探し始める
      if (lo[s] !== 0 && lo[s] < ll && hi[s] === 0) {
        zz[llPos] = 0;
        llPos = s;
        ll = lo[s];
        zz[s] = ll;
      }
      if (hi[s] !== 0 && lo[s] === 0) {
        lh = hi[s];
        lhPos = s;
        zz[s] = lh;
        look = -1;
      }
    } else {
      if (hi[s] !== 0 && hi[s] > lh && lo[s] === 0) {
        zz[lhPos] = 0;
        lhPos = s;
        lh = hi[s];
        zz[s] = lh;
      }
      if (lo[s] !== 0 && hi[s] === 0) {
        ll = lo[s];
        llPos = s;
        zz[s] = ll;
        look = 1;
      }
    }
  }
  const out: ZigzagPoint[] = [];
  for (let s = 0; s < n; s++) if (zz[s] !== 0) out.push({ i: from + s, price: zz[s] });
  return out;
}

/** 移動平均の向きで区切る ZigZag の、向きが変わったとみなす決め方 */
export interface MaTurnRule {
  /**
   * turn: MA が少しでも逆を向いたら（A）。
   * atr: MA がその脚の一番高い（安い）所から ATR × atrMult 以上戻したら（B。横ばいの小さな揺れを無視する）。
   * cross: MA が逆を向き、終値も MA の反対側に出たら（C）
   */
  kind: 'turn' | 'atr' | 'cross';
  close?: ArrayLike<number>;
  atr?: ArrayLike<number>;
  atrMult?: number;
  /**
   * MA がこの本数のあいだ脚の端（上向きなら一番高い値）を更新しなかったら、戻した幅が小さくても向きが変わったとみなす
   * （MA が横ばいになって波が終わったのを拾う。0 か無しなら使わない）。値もその本数のあいだ脚の端を更新していないときだけ
   * （MA は止まっていても値が高値を更新している所で区切ると、1〜2 本だけの小さな谷ができた。M1 2022-05-02 08:19〜08:20）
   */
  stall?: number;
}

/**
 * 移動平均の向きで区切る ZigZag。ma が上向きの間の一番高い足を山、下向きの間の一番安い足を谷にして結ぶ
 * （MA が上向きから下向きに変わったら、前の谷から後で一番高い足が山に決まる）。
 * from〜to の足だけを使う。最後の点は、今の向きでのその時点の一番高い（安い）足（先の足しだいで動く）
 */
export function zigzagByMa(
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  ma: ArrayLike<number>,
  from: number,
  to: number,
  rule: MaTurnRule = { kind: 'turn' },
): ZigzagPoint[] {
  const out: ZigzagPoint[] = [];
  // 点は足の順に 1 つずつ（始まりの点と最初の山・谷が同じ足になったときは、後の方に置き換える。
  // 同じ時刻の点が 2 つあると、チャートの部品が描けずに止まる）
  const add = (p: ZigzagPoint) => {
    if (out.length && p.i <= out[out.length - 1].i) out[out.length - 1] = p;
    else out.push(p);
  };
  const mult = rule.atrMult ?? 1;
  // 今の脚が逆を向いたか
  const flips = (j: number, dir: number, maExt: number) => {
    const up = dir > 0;
    if (rule.kind === 'atr') {
      const a = rule.atr?.[j] ?? NaN;
      if (!Number.isFinite(a)) return false;
      return up ? ma[j] <= maExt - mult * a : ma[j] >= maExt + mult * a;
    }
    const turned = up ? ma[j] < ma[j - 1] : ma[j] > ma[j - 1];
    if (!turned) return false;
    if (rule.kind === 'cross') {
      const c = rule.close?.[j] ?? NaN;
      return up ? c < ma[j] : c > ma[j];
    }
    return true;
  };
  let dir = 0;
  // 今の脚の一番高い・安い足（前の点より後）と、その脚の MA の一番高い・安い値
  let ext = -1;
  let maExt = NaN;
  let maExtI = -1;
  const stall = rule.stall ?? 0;
  const better = (q: number, e: number) => (dir > 0 ? high[q] > high[e] : low[q] < low[e]);
  const startLeg = (pivot: number, j: number) => {
    ext = Math.min(pivot + 1, j);
    for (let q = ext; q <= j; q++) if (better(q, ext)) ext = q;
    // MA の端は、向きが変わったと決まった足から数える（その前の MA はまだ前の向きの続き）
    maExt = ma[j];
    maExtI = j;
  };
  for (let j = from + 1; j <= to; j++) {
    const a = ma[j - 1];
    const b = ma[j];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (dir === 0) {
      const d = b > a ? 1 : b < a ? -1 : 0;
      if (d === 0) continue;
      // 始まり: 向きが決まるまでの足の、反対側の端を最初の点にする
      let s = j;
      for (let q = j; q >= from && Number.isFinite(ma[q]); q--) if (d > 0 ? low[q] < low[s] : high[q] > high[s]) s = q;
      add({ i: s, price: d > 0 ? low[s] : high[s] });
      dir = d;
      startLeg(s, j);
      continue;
    }
    if (flips(j, dir, maExt) || (stall > 0 && j - maExtI >= stall && j - ext >= stall)) {
      // 向きが変わった: 今までの脚の端を点に決め、反対の脚を始める
      add({ i: ext, price: dir > 0 ? high[ext] : low[ext] });
      const pivot = ext;
      dir = -dir;
      startLeg(pivot, j);
      continue;
    }
    if (better(j, ext)) ext = j;
    if (dir > 0 ? b > maExt : b < maExt) {
      maExt = b;
      maExtI = j;
    }
  }
  if (dir !== 0 && ext >= 0) add({ i: ext, price: dir > 0 ? high[ext] : low[ext] });
  return out;
}

/** ATR（単純平均の真の値幅）。high・low・close は古い順 */
export function atr(high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, period: number): Float64Array {
  const n = high.length;
  const tr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pc = i > 0 ? close[i - 1] : close[i];
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc));
  }
  return sma(tr, period);
}
