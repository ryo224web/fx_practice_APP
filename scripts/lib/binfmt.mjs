// 価格データのファイル形式（1 分足 1 本 = Int32 × 9 = 36 バイト、リトルエンディアン）
//   [0]    足の開始時刻（UTC、1970 年からの分）
//   [1-4]  Bid の始値・高値・安値・終値（価格 × 10^digits の整数）
//   [5-8]  Ask の始値・高値・安値・終値（同上）。Ask が無い足は 0（データ元の欠け。Ask を作り出しはしない）
// 読み込み側は src/core/binfmt.ts。形式を変えるときは両方を直すこと。

export const FIELDS = 9;

/**
 * @param {Array<[number, number, number, number, number]>} bid dukascopy-node の配列形式
 * @param {Array<[number, number, number, number, number]>} ask
 * @param {number} digits
 * @returns {Uint8Array}
 */
export function encodeMonth(bid, ask, digits) {
  const scale = 10 ** digits;
  const askByTime = new Map(ask.map((a) => [a[0], a]));
  const out = new Int32Array(bid.length * FIELDS);
  bid.forEach((b, i) => {
    const a = askByTime.get(b[0]);
    const o = i * FIELDS;
    out[o] = Math.round(b[0] / 60_000);
    for (let k = 1; k <= 4; k++) {
      out[o + k] = Math.round(b[k] * scale);
      out[o + 4 + k] = a ? Math.round(a[k] * scale) : 0;
    }
  });
  return new Uint8Array(out.buffer);
}
