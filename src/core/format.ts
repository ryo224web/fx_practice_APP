import { serverToUtc, toDisplay, type DisplayZone, type ServerTimeRule } from './time';

const pad = (n: number) => String(n).padStart(2, '0');

/** MT4 と同じ "2026.10.20 15:30" 形式 */
export function formatTime(utcMs: number, zone: DisplayZone, rule: ServerTimeRule, seconds = false): string {
  const d = new Date(toDisplay(utcMs, zone, rule));
  const s = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return seconds ? `${s}:${pad(d.getUTCSeconds())}` : s;
}

/** <input type="datetime-local"> 用の値（表示タイムゾーンの壁時計） */
export function toLocalInput(utcMs: number, zone: DisplayZone, rule: ServerTimeRule): string {
  return new Date(toDisplay(utcMs, zone, rule)).toISOString().slice(0, 16);
}

/** toLocalInput の逆。読めなければ NaN */
export function fromLocalInput(value: string, zone: DisplayZone, rule: ServerTimeRule): number {
  const wall = Date.parse(value + ':00Z');
  if (Number.isNaN(wall)) return NaN;
  return zone === 'jst' ? wall - 9 * 3_600_000 : serverToUtc(wall, rule);
}

export function formatPrice(p: number, digits: number): string {
  return p.toFixed(digits);
}

/** 円の金額。MT4 と同じく桁区切りあり・小数なし */
export function formatMoney(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('ja-JP');
}
