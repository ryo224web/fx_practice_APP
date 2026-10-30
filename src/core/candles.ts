import { type ServerTimeRule, utcToServer } from './time';

/** ローソク足 1 本。t は足の始まりの時刻（UTC ミリ秒） */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** 時間足と 1 本あたりの分数（W1・MN はおおよその値。区切りは periodKey で決める） */
export const TIMEFRAMES = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10080,
  MN: 43200,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/** 1970-01-01 は木曜で、最初の日曜は 3 日後。MT4 の週足は日曜 0:00（サーバー時刻）始まりなので 4 日ずらして日曜を区切りにする */
const WEEK_ORIGIN = 4 * DAY;

/** サーバー時刻での区切り番号と、その区切りの開始時刻（サーバー時刻） */
function periodKey(server: number, tf: Timeframe): { key: number; start: number } {
  if (tf === 'MN') {
    const d = new Date(server);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return { key: y * 12 + m, start: Date.UTC(y, m, 1) };
  }
  if (tf === 'W1') {
    const key = Math.floor((server + WEEK_ORIGIN) / (7 * DAY));
    return { key, start: key * 7 * DAY - WEEK_ORIGIN };
  }
  const size = TIMEFRAMES[tf] * MINUTE;
  const key = Math.floor(server / size);
  return { key, start: key * size };
}

/** 上位足と、各足の最初の 1 分足の位置 */
export interface Aggregated {
  bars: Bar[];
  /** starts[i] = bars[i] を作った最初の 1 分足の添字 */
  starts: number[];
}

/**
 * 1 分足から上位足を作る。区切りはサーバー時刻で行うので、
 * 日足は MT4 と同じく NY 17:00（サーバー 0:00）で切り替わる。
 * 上位足はすべて同じ 1 分足から作るため、時間足どうしでずれない。
 */
export function aggregateWithIndex(m1: readonly Bar[], tf: Timeframe, rule: ServerTimeRule): Aggregated {
  if (tf === 'M1') return { bars: m1.slice(), starts: m1.map((_, i) => i) };

  const bars: Bar[] = [];
  const starts: number[] = [];
  let cur: Bar | undefined;
  let curKey = NaN;
  for (let i = 0; i < m1.length; i++) {
    const b = m1[i];
    const server = utcToServer(b.t, rule);
    const { key, start } = periodKey(server, tf);
    if (key !== curKey) {
      if (cur) bars.push(cur);
      curKey = key;
      // 足の開始時刻 = 区切り時刻をサーバー時刻から UTC に戻したもの
      const offset = server - b.t;
      cur = { t: start - offset, o: b.o, h: b.h, l: b.l, c: b.c };
      starts.push(i);
    } else {
      if (b.h > cur!.h) cur!.h = b.h;
      if (b.l < cur!.l) cur!.l = b.l;
      cur!.c = b.c;
    }
  }
  if (cur) bars.push(cur);
  return { bars, starts };
}

/** 時刻 t（UTC）を含む足の始まりの時刻（UTC）。aggregateWithIndex と同じ区切り */
export function periodStartUtc(t: number, tf: Timeframe, rule: ServerTimeRule): number {
  if (tf === 'M1') return t - (t % MINUTE);
  const server = utcToServer(t, rule);
  return periodKey(server, tf).start - (server - t);
}

export function aggregate(m1: readonly Bar[], tf: Timeframe, rule: ServerTimeRule): Bar[] {
  return aggregateWithIndex(m1, tf, rule).bars;
}

/** m1[from..to]（両端を含む）を 1 本の足にまとめる。リプレイ中の作りかけの足に使う */
export function mergeBars(m1: readonly Bar[], from: number, to: number, t: number): Bar {
  const first = m1[from];
  const bar: Bar = { t, o: first.o, h: first.h, l: first.l, c: m1[to].c };
  for (let i = from + 1; i <= to; i++) {
    if (m1[i].h > bar.h) bar.h = m1[i].h;
    if (m1[i].l < bar.l) bar.l = m1[i].l;
  }
  return bar;
}
