import { describe, expect, it } from 'vitest';
import { blockedWindows, jaTitle, parseFf, weekKey } from '../server/econCalendar.ts';
import { countdown, renderKindle, weekDays } from '../server/kindle.ts';
import { activeWarnings } from '../server/warnings.ts';
import { BatteryLog } from '../server/kindleImage.ts';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iconImg, kindOf, mergeJma, parseOpenMeteo, snowSummary, type Weather } from '../server/weather.ts';

const rows = [
  { title: 'Prelim GDP q/q', country: 'USD', date: '2026-11-25T08:30:00-05:00', impact: 'High', forecast: '3.5%', previous: '3.4%' },
  { title: 'Core PCE Price Index m/m', country: 'USD', date: '2026-11-25T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.3%' },
  { title: 'CB Consumer Confidence', country: 'USD', date: '2026-11-25T10:00:00-05:00', impact: 'Medium', forecast: '', previous: '' },
  { title: 'Bank Holiday', country: 'USD', date: '2026-11-26T08:00:00-05:00', impact: 'Holiday' },
  { title: 'broken', country: 'USD', date: 'x', impact: 'High' },
];
const evs = parseFf(rows);
const jst = (s: string) => Date.parse(`${s}+09:00`);

describe('経済指標カレンダー', () => {
  it('ForexFactory の時刻を UTC にする', () => {
    expect(evs).toHaveLength(4);
    expect(new Date(evs[1].at).toISOString()).toBe('2026-11-25T13:30:00.000Z');
    expect(weekKey(evs[1].at)).toBe('2026-11-22');
  });
  it('触らない時間は High の前後をまとめる', () => {
    const w = blockedWindows(evs, 30, 30);
    expect(w).toHaveLength(1);
    expect(w[0].events).toHaveLength(2);
    expect(w[0].from).toBe(jst('2026-11-25T22:00'));
    expect(w[0].to).toBe(jst('2026-11-25T23:00'));
  });
  it('日本語の短い名前', () => {
    expect(jaTitle('Core PCE Price Index m/m')).toBe('PCE コア 前月比');
    expect(jaTitle('CPI y/y')).toBe('CPI 前年比');
    expect(jaTitle('Core CPI m/m')).toBe('コア CPI 前月比');
    expect(jaTitle('Fed Chair Warsh Speaks')).toBe('FRB Warsh 議長');
    expect(jaTitle('Something New q/q')).toBe('Something New 前期比');
  });
});

describe('カウントダウン', () => {
  it('触らない時間の前・中（発表前・発表後）・ない', () => {
    expect(countdown(evs, jst('2026-11-25T20:00'), 30, 30)).toMatchObject({ mode: 'next', ms: 150 * 60_000 });
    expect(countdown(evs, jst('2026-11-25T22:20'), 30, 30)).toMatchObject({ mode: 'pre', ms: 10 * 60_000 });
    expect(countdown(evs, jst('2026-11-25T22:38'), 30, 30)).toMatchObject({ mode: 'post', ms: 8 * 60_000, left: 22 * 60_000 });
    expect(countdown(evs, jst('2026-11-25T23:00'), 30, 30)).toMatchObject({ mode: 'none' });
  });
  it('週の欄は土曜の朝 8 時を過ぎたら来週', () => {
    const day = (s: string) => new Date(weekDays(jst(s))[0] + 9 * 3600_000).toISOString().slice(0, 10);
    expect(day('2026-11-25T12:00')).toBe('2026-11-23'); // 水 → その週の月曜
    expect(day('2026-11-28T07:00')).toBe('2026-11-23'); // 土の朝（NY は金曜）
    expect(day('2026-11-28T09:00')).toBe('2026-11-30'); // 土の朝 9 時 → 来週
    expect(day('2026-11-29T12:00')).toBe('2026-11-30'); // 日
  });
});

describe('電池の記録', () => {
  it('書けないときは取っておき、次に書けたときにまとめて書く', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'batt-'));
    const out = join(dir, 'ro', 'battery.csv');
    const log = new BatteryLog(out, join(dir, 'pending.csv'));
    // 書けない（置き場のフォルダが無い）
    await log.append('a\n');
    await log.append('b\n');
    expect(readFileSync(join(dir, 'pending.csv'), 'utf8')).toBe('a\nb\n');
    // 書けるようになった
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'ro'));
    await log.append('c\n');
    expect(readFileSync(out, 'utf8')).toBe('a\nb\nc\n');
    expect(existsSync(join(dir, 'pending.csv'))).toBe(false);
  });
});

describe('気象警報', () => {
  it('その市町村で発表・継続の、雪と大雨と特別警報だけを、警報を先に', () => {
    const reports = [
      { warning: { class20Items: [{ areaCode: '9990100', kinds: [{ code: '14', status: '発表' }, { code: '10', status: '解除' }] }, { areaCode: '9990200', kinds: [{ code: '06', status: '発表' }] }] } },
      { warning: { class20Items: [{ areaCode: '9990100', kinds: [{ code: '06', status: '継続' }, { status: '発表警報・注意報はなし' }] }] } },
    ];
    // 雷注意報は出さない（雪と大雨に関係するものと特別警報だけ）
    expect(activeWarnings(reports, '9990100')).toEqual(['大雪警報']);
    expect(activeWarnings(null, '9990100')).toEqual([]);
  });
});

describe('天気', () => {
  it('Open-Meteo を読む・マーク', () => {
    const w = parseOpenMeteo(
      {
        current: { temperature_2m: -1.2, weather_code: 0, is_day: 0 },
        hourly: { time: [1795618800], temperature_2m: [-1.7], precipitation_probability: [10], weather_code: [71], is_day: [0], snowfall: [0.7], snow_depth: [0.32] },
        daily: { time: [1795618800], weather_code: [85], temperature_2m_max: [6.7], temperature_2m_min: [-1.7], precipitation_probability_max: [100] },
      },
      1,
    )!;
    expect(w.hourly[0]).toEqual({ at: 1795618800_000, temp: -1.7, pop: 10, code: 71, isDay: false, snow: 0.7, depth: 32 });
    expect(kindOf(85)).toBe('snow');
    expect(kindOf(61)).toBe('rain');
    expect(kindOf(2)).toBe('partly');
    expect(iconImg(71, true, 30)).toContain('alt="雪"');
  });
  it('天気と気温は気象庁、降水確率と積雪は既定の計算', () => {
    const h = (code: number, temp: number, pop: number | null, depth: number | null) => ({ at: 1000, temp, pop, code, isDay: false, snow: 0, depth });
    const base: Weather = { fetchedAt: 1, current: { temp: 1, code: 45, isDay: false }, hourly: [h(45, 1, 30, 12)], daily: [{ at: 0, code: 45, max: 5, min: 0, pop: 40 }] };
    const jma: Weather = { fetchedAt: 1, current: { temp: 2, code: 2, isDay: false }, hourly: [h(2, 2, null, null)], daily: [{ at: 0, code: 2, max: 6, min: -1, pop: null }] };
    const m = mergeJma(base, jma);
    expect(m.current).toEqual({ temp: 2, code: 2, isDay: false });
    expect(m.hourly[0]).toMatchObject({ code: 2, temp: 2, pop: 30, depth: 12 });
    expect(m.daily[0]).toEqual({ at: 0, code: 2, max: 6, min: -1, pop: 40 });
  });
  it('翌朝 9 時までの降雪と今の積雪', () => {
    const hour = (s: string, snow: number, depth: number | null) => ({ at: jst(s), temp: 0, pop: 0, code: 71, isDay: false, snow, depth });
    const w: Weather = {
      fetchedAt: 0,
      current: { temp: 0, code: 71, isDay: false },
      daily: [],
      hourly: [hour('2026-11-27T15:00', 9, 30), hour('2026-11-27T16:00', 1, 31), hour('2026-11-28T09:00', 2, 35), hour('2026-11-28T10:00', 5, 40)],
    };
    // 15:20 → 16:00〜翌 9:00 の分（1 + 2）。15:00 の分（14〜15 時に降った）は入れない
    expect(snowSummary(w, jst('2026-11-27T15:20'))).toEqual({ until: jst('2026-11-28T09:00'), cm: 3, depth: 30 });
    // 雪も積雪も無ければ出さない
    expect(snowSummary({ ...w, hourly: [hour('2026-11-27T15:00', 0, 0)] }, jst('2026-11-27T15:20'))).toBeNull();
  });
});

describe('Kindle の画面', () => {
  const opt = { currencies: ['USD', 'JPY'], impacts: ['High' as const, 'Medium' as const], beforeMin: 30, afterMin: 30, width: 1024, height: 758, calendarAt: jst('2026-11-25T20:00'), weather: null };
  it('発表前は「発表まで」、祝日も出す', () => {
    const html = renderKindle(evs, { ...opt, now: jst('2026-11-25T22:20') });
    expect(html).toContain('発表まで');
    expect(html).toContain('10 分');
    expect(html).toContain('祝日 USD');
    expect(html).toContain('PCE コア 前月比');
  });
  it('今年あと何日・警報と注意報・白黒の反転', () => {
    const html = renderKindle(evs, { ...opt, now: jst('2026-11-27T10:00'), warnings: ['大雪警報', '雷注意報'] });
    expect(html).toContain('今年あと 34 日');
    expect(html).toContain('⚠ 大雪警報');
    expect(renderKindle(evs, { ...opt, now: jst('2026-12-31T10:00') })).toContain('今年あと 0 日');
    expect(renderKindle(evs, { ...opt, now: jst('2026-11-27T10:00'), dark: true })).toContain('filter:invert(1)');
    expect(renderKindle(evs, { ...opt, now: jst('2026-11-27T10:00') })).not.toContain('filter:invert(1)');
  });
  it('電池の残量を右上に出す（少なければ「充電して」、30 分より古ければ出さない）', () => {
    const now = jst('2026-11-25T20:00');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 67, charging: false, at: now } })).toContain('67<span class="pc">%</span>');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 15, charging: false, at: now } })).toContain('15<span class="pc">%</span><span class="pc"> 充電して</span>');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 15, charging: true, at: now } })).toContain('15<span class="pc">%</span> 充電中');
    // ケーブルが挿さっていれば、充電を止めている間も充電中の絵
    expect(renderKindle(evs, { ...opt, now, chargingIcon: 'data:image/png;base64,AA', normalIcon: 'data:image/png;base64,BB', battery: { level: 85, charging: false, held: true, plugged: true, at: now } })).toContain('base64,AA');
    // ふだんの絵は充電していないときだけ
    expect(renderKindle(evs, { ...opt, now, normalIcon: 'data:image/png;base64,BB', battery: { level: 50, charging: false, at: now } })).toContain('src="data:image/png;base64,BB"');
    expect(renderKindle(evs, { ...opt, now, normalIcon: 'data:image/png;base64,BB', battery: { level: 50, charging: true, at: now } })).not.toContain('base64,BB');
    // 充電中のマークの画像があれば、字の代わりにそれを出す
    expect(renderKindle(evs, { ...opt, now, chargingIcon: 'data:image/png;base64,AA', battery: { level: 50, charging: true, at: now } })).toContain('<img class="chg" src="data:image/png;base64,AA"');
    // 充電を止めている間は何も足さない（「お休み中」は要らないと言われた。2026-11-27）
    expect(renderKindle(evs, { ...opt, now, battery: { level: 80, charging: false, held: true, at: now } })).toMatch(/80<span class="pc">%<\/span><\/span>/);
    expect(renderKindle(evs, { ...opt, now, battery: { level: 67, charging: false, at: now - 31 * 60_000 } })).not.toContain('class="bt');
  });
  it('触らない時間の外はカウントダウン', () => {
    const html = renderKindle(evs, { ...opt, now: jst('2026-11-25T20:00') });
    expect(html).toContain('次の ★★★ まで');
    expect(html).toContain('2:30');
  });
});
