// MT4 のヒストリーファイル（.hst）を読む。Dukascopy のサイトは 1 分足を .hst でも書き出せる。
//   見出し 148 バイト: 版（int32。400 か 401）・著作権（64）・銘柄（12）・時間足（int32。1 = M1）・桁数（int32）・…
//   版 400: 1 本 44 バイト  時刻（int32・秒）・始値・安値・高値・終値・出来高（double）
//   版 401: 1 本 60 バイト  時刻（int64・秒）・始値・高値・安値・終値（double）・出来高（int64）・スプレッド（int32）・実出来高（int64）
// 時刻は書き出したときのタイムゾーン（Dukascopy の初期設定は GMT）。ここでは GMT として読む。

/**
 * @param {Buffer} buf
 * @returns {{ symbol: string, period: number, digits: number, bars: Array<[number, number, number, number, number, number]> }}
 *   bars は [時刻（UTC ミリ秒）, 始値, 高値, 安値, 終値, 出来高]
 */
export function parseHst(buf) {
  if (buf.length < 148) throw new Error('.hst の見出しが短すぎます');
  const version = buf.readInt32LE(0);
  const symbol = buf.subarray(68, 80).toString('latin1').replace(/\0.*$/s, '');
  const period = buf.readInt32LE(80);
  const digits = buf.readInt32LE(84);
  const size = version === 400 ? 44 : version === 401 ? 60 : 0;
  if (!size) throw new Error(`.hst の版 ${version} は読めません（400 か 401）`);
  const n = Math.floor((buf.length - 148) / size);
  const bars = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = 148 + i * size;
    if (version === 400) {
      // 400 は 始値・安値・高値・終値 の順
      bars[i] = [buf.readInt32LE(o) * 1000, buf.readDoubleLE(o + 4), buf.readDoubleLE(o + 20), buf.readDoubleLE(o + 12), buf.readDoubleLE(o + 28), buf.readDoubleLE(o + 36)];
    } else {
      bars[i] = [Number(buf.readBigInt64LE(o)) * 1000, buf.readDoubleLE(o + 8), buf.readDoubleLE(o + 16), buf.readDoubleLE(o + 24), buf.readDoubleLE(o + 32), Number(buf.readBigInt64LE(o + 40))];
    }
  }
  return { symbol, period, digits, bars };
}
