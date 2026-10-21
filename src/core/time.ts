// 時刻変換。内部の時刻はすべて UTC のミリ秒で持ち、表示や足の区切りのときだけ変換する。

/** ブローカーのサーバー時刻の決まり方 */
export type ServerTimeRule =
  /** ニューヨーク時間 + 7 時間（米国の夏時間に連動。NY 17:00 = サーバー 0:00） */
  | { kind: 'ny-close' }
  /** 冬 UTC+2 / 夏 UTC+3 を欧州の夏時間に合わせて切り替える */
  | { kind: 'eu-dst' }
  /** 夏時間なしの固定オフセット */
  | { kind: 'fixed'; offsetMinutes: number };

/** TitanFX の実測値（2026-10-21: サーバー 08:43 / 日本 14:43 → UTC+3）に合う既定ルール */
export const DEFAULT_SERVER_RULE: ServerTimeRule = { kind: 'ny-close' };

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** IANA タイムゾーンの、ある瞬間における UTC からのずれ（分） */
export function tzOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const truncated = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return Math.round((asUtc - truncated) / MINUTE);
}

/** ある瞬間（UTC）のサーバー時刻の UTC オフセット（分） */
export function serverOffsetMinutes(rule: ServerTimeRule, utcMs: number): number {
  switch (rule.kind) {
    case 'ny-close':
      return tzOffsetMinutes('America/New_York', utcMs) + 7 * 60;
    case 'eu-dst':
      return tzOffsetMinutes('Europe/Helsinki', utcMs);
    case 'fixed':
      return rule.offsetMinutes;
  }
}

/** UTC → サーバー時刻（壁時計の値を UTC 形式のミリ秒で表したもの） */
export function utcToServer(utcMs: number, rule: ServerTimeRule): number {
  return utcMs + serverOffsetMinutes(rule, utcMs) * MINUTE;
}

/**
 * サーバー時刻 → UTC。MT4 の CSV など、サーバー時刻で書かれた値を取り込むときに使う。
 * 夏時間の切り替わりは週末（市場休場中）に起きるため、曖昧な時刻は実データには現れない。
 */
export function serverToUtc(serverMs: number, rule: ServerTimeRule): number {
  let utc = serverMs - serverOffsetMinutes(rule, serverMs) * MINUTE;
  utc = serverMs - serverOffsetMinutes(rule, utc) * MINUTE;
  return utc;
}

/** 表示用のタイムゾーン */
export type DisplayZone = 'jst' | 'server';

/** チャート表示用に、UTC を表示タイムゾーンの壁時計の値へずらす */
export function toDisplay(utcMs: number, zone: DisplayZone, rule: ServerTimeRule): number {
  return zone === 'jst' ? utcMs + 9 * 60 * MINUTE : utcToServer(utcMs, rule);
}
