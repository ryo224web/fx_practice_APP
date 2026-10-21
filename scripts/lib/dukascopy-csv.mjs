// Dukascopy の CSV の 1 行を読む（import-csv.mjs から使う。テストは tests/import.test.ts）

/**
 * 日時を UTC ミリ秒にする。読めなければ NaN。
 * ダウンロードの設定によって並びが違うので、次のどれでも読む:
 *   2026.10.21 00:00:00 / 2026.10.21 00:00:00.000 / 2026-10-21 00:00:00 / 21.10.2026 00:00:00.000
 */
export function parseDukascopyTime(s) {
  const m = /^\s*(\d{1,4})[.\-/](\d{1,2})[.\-/](\d{1,4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/.exec(s);
  if (!m) return NaN;
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[1].length !== 4 && m[3].length === 4) [y, d] = [d, y]; // 日.月.年
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  return Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

/**
 * 1 行を [時刻, 始値, 高値, 安値, 終値, 出来高] にする。見出しや読めない行は null。
 * 1 分足なので秒は切り捨てる。
 */
export function parseDukascopyRow(line) {
  const c = line.split(',');
  if (c.length < 6) return null;
  const t = parseDukascopyTime(c[0]);
  const v = c.slice(1, 6).map((x) => Number(x));
  if (!Number.isFinite(t) || v.some((x) => !Number.isFinite(x))) return null;
  const [o, h, l, cl, vol] = v;
  if (!(h >= l) || !(o > 0) || !(cl > 0)) return null;
  return [Math.floor(t / 60_000) * 60_000, o, h, l, cl, vol];
}
