import { type ServerTimeRule, utcToServer } from './time';

/** ローソク足 1 本。t は足の始まりの時刻（UTC ミリ秒） */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export const TIMEFRAMES = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

const MINUTE = 60_000;

/**
 * 1 分足から上位足を作る。区切りはサーバー時刻で行うので、
 * 日足は MT4 と同じく NY 17:00（サーバー 0:00）で切り替わる。
 * 上位足はすべて同じ 1 分足から作るため、時間足どうしでずれない。
 */
export function aggregate(m1: readonly Bar[], tf: Timeframe, rule: ServerTimeRule): Bar[] {
  const size = TIMEFRAMES[tf] * MINUTE;
  if (size === MINUTE) return m1.slice();

  const out: Bar[] = [];
  let cur: Bar | undefined;
  let curKey = NaN;
  for (const b of m1) {
    const server = utcToServer(b.t, rule);
    const key = Math.floor(server / size);
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      // 足の開始時刻 = 区切り時刻をサーバー時刻から UTC に戻したもの
      const offset = server - b.t;
      cur = { t: key * size - offset, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur!.h = Math.max(cur!.h, b.h);
      cur!.l = Math.min(cur!.l, b.l);
      cur!.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}
