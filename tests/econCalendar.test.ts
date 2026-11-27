import { describe, expect, it } from 'vitest';
import { blockedWindows, jaTitle, parseFf, weekKey } from '../server/econCalendar.ts';
import { countdown, renderKindle, weekDays } from '../server/kindle.ts';
import { iconImg, kindOf, parseOpenMeteo, snowSummary, type Weather } from '../server/weather.ts';

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
  it('電池の残量を右上に出す（少なければ「充電して」、30 分より古ければ出さない）', () => {
    const now = jst('2026-11-25T20:00');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 67, charging: false, at: now } })).toContain('電池 67%');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 15, charging: false, at: now } })).toContain('電池 15% 充電して');
    expect(renderKindle(evs, { ...opt, now, battery: { level: 15, charging: true, at: now } })).toContain('電池 15% 充電中');
    // 充電中のマークの画像があれば、字の代わりにそれを出す
    expect(renderKindle(evs, { ...opt, now, chargingIcon: 'data:image/png;base64,AA', battery: { level: 50, charging: true, at: now } })).toContain('<img class="chg" src="data:image/png;base64,AA"');
    // 充電を止めている間は何も足さない（「お休み中」は要らないと言われた。2026-11-27）
    expect(renderKindle(evs, { ...opt, now, battery: { level: 80, charging: false, held: true, at: now } })).toMatch(/電池 80%<\/span>/);
    expect(renderKindle(evs, { ...opt, now, battery: { level: 67, charging: false, at: now - 31 * 60_000 } })).not.toContain('電池');
  });
  it('触らない時間の外はカウントダウン', () => {
    const html = renderKindle(evs, { ...opt, now: jst('2026-11-25T20:00') });
    expect(html).toContain('次の ★★★ まで');
    expect(html).toContain('2:30');
  });
});
