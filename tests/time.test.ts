import { describe, expect, it } from 'vitest';
import { serverOffsetMinutes, serverToUtc, utcToServer, type ServerTimeRule } from '../src/core/time';

const ny: ServerTimeRule = { kind: 'ny-close' };
const eu: ServerTimeRule = { kind: 'eu-dst' };
const utc = (s: string) => Date.parse(s + 'Z');

describe('ny-close（NY + 7 時間）', () => {
  it('実測値と一致する: 2026-10-21 サーバー 08:43 = 日本 14:43', () => {
    const jst1443 = utc('2026-10-21T05:43:00'); // 日本 14:43 = UTC 05:43
    expect(new Date(utcToServer(jst1443, ny)).toISOString()).toBe('2026-10-21T08:43:00.000Z');
  });

  it('米国の夏時間は UTC+3、冬時間は UTC+2', () => {
    expect(serverOffsetMinutes(ny, utc('2026-07-01T00:00:00'))).toBe(180);
    expect(serverOffsetMinutes(ny, utc('2026-01-15T00:00:00'))).toBe(120);
  });

  it('米欧で夏時間がずれる期間は米国側に合わせる', () => {
    // 2026-10-25（日）欧州が冬時間へ、2026-11-01（日）米国が冬時間へ
    expect(serverOffsetMinutes(ny, utc('2026-10-28T12:00:00'))).toBe(180);
    expect(serverOffsetMinutes(eu, utc('2026-10-28T12:00:00'))).toBe(120);
    // 2026-03-08 米国が夏時間へ、2026-03-29 欧州が夏時間へ
    expect(serverOffsetMinutes(ny, utc('2026-03-18T12:00:00'))).toBe(180);
    expect(serverOffsetMinutes(eu, utc('2026-03-18T12:00:00'))).toBe(120);
  });

  it('日足の区切り（サーバー 0:00）は常に NY 17:00', () => {
    // 夏: NY 17:00 EDT = UTC 21:00 / 冬: NY 17:00 EST = UTC 22:00
    expect(new Date(utcToServer(utc('2026-07-01T21:00:00'), ny)).toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(new Date(utcToServer(utc('2026-01-15T22:00:00'), ny)).toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('サーバー時刻 → UTC は往復で元に戻る（切り替え週の前後も含む）', () => {
    for (const s of ['2026-03-06T12:00:00', '2026-03-09T00:00:00', '2026-10-30T23:59:00', '2026-11-02T00:00:00', '2008-03-10T00:00:00']) {
      const u = utc(s);
      expect(serverToUtc(utcToServer(u, ny), ny)).toBe(u);
    }
  });
});
