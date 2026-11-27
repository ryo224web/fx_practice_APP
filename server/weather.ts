// 天気（2026-11-26）。Kindle の画面に今の天気・1 時間ごと・週間を出すため。
// 取ってくる先: Open-Meteo（https://open-meteo.com/。鍵は要らない）。30 分に 1 回。過去 6 日〜先 7 日。
// 天気のマーク・気温は気象庁の計算（models=jma_seamless）、降水確率と積雪の深さは既定の計算（mergeJma。2026-11-27）。
// 場所（"緯度,経度"）はデータの置き場の config.json の latlon（環境変数 FXP_WEATHER_LATLON でも）。住んでいる場所なので、公開しているリポジトリには書かない。
// 最後に取ったものは Dropbox の Claude/kindle_dashboard/weather.json に残す（開発サーバーを起動し直しても出せるように。KINDLE_DIR）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';


export interface Hour {
  /** UTC のミリ秒 */
  at: number;
  temp: number;
  /** 降水確率 % */
  pop: number | null;
  code: number;
  isDay: boolean;
  /** その 1 時間の降雪（cm） */
  snow: number;
  /** 積雪（cm） */
  depth: number | null;
}

export interface Day {
  /** 日本時間のその日の 0:00（UTC のミリ秒） */
  at: number;
  code: number;
  max: number;
  min: number;
  pop: number | null;
}

export interface Weather {
  fetchedAt: number;
  current: { temp: number; code: number; isDay: boolean };
  hourly: Hour[];
  daily: Day[];
}

interface OmResponse {
  current?: { temperature_2m: number; weather_code: number; is_day: number };
  hourly?: { time: number[]; temperature_2m: number[]; precipitation_probability: (number | null)[]; weather_code: number[]; is_day: number[]; snowfall?: (number | null)[]; snow_depth?: (number | null)[] };
  daily?: { time: number[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
}

/** model: 'jma_seamless' で気象庁の計算（MSM・GSM）を使う。無ければ Open-Meteo の既定（いくつかの計算を組み合わせたもの） */
export function omUrl(latlon: string, model?: string) {
  const [lat, lon] = latlon.split(',').map((s) => s.trim());
  const q = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,weather_code,is_day',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day,snowfall,snow_depth',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Tokyo',
    timeformat: 'unixtime',
    // 週間は日曜〜土曜で出すので、今週の過ぎた日（最大 6 日）も取る
    past_days: '6',
    forecast_days: '8',
  });
  if (model) q.set('models', model);
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

/** Open-Meteo の返事を読む（timeformat=unixtime。日の時刻は日本時間の 0:00） */
export function parseOpenMeteo(r: OmResponse, fetchedAt: number): Weather | null {
  const c = r.current;
  const h = r.hourly;
  const d = r.daily;
  if (!c || !h || !d) return null;
  return {
    fetchedAt,
    current: { temp: c.temperature_2m, code: c.weather_code, isDay: c.is_day === 1 },
    hourly: h.time.map((t, i) => ({
      at: t * 1000,
      temp: h.temperature_2m[i],
      pop: h.precipitation_probability[i] ?? null,
      code: h.weather_code[i],
      isDay: h.is_day[i] === 1,
      snow: h.snowfall?.[i] ?? 0,
      // Open-Meteo の積雪は m
      depth: h.snow_depth?.[i] == null ? null : Math.round(h.snow_depth[i]! * 100),
    })),
    daily: d.time.map((t, i) => ({
      at: t * 1000,
      code: d.weather_code[i],
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      pop: d.precipitation_probability_max[i] ?? null,
    })),
  };
}

// ---- 天気のマーク（WMO の天気コード）----

export type Kind = 'clear' | 'partly' | 'cloud' | 'fog' | 'rain' | 'snow' | 'sleet' | 'thunder';

export function kindOf(code: number): Kind {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code === 56 || code === 57 || code === 66 || code === 67) return 'sleet';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  return 'rain'; // 51〜65・80〜82
}

export const KIND_JA: Record<Kind, string> = {
  clear: '晴れ',
  partly: '晴れ時々くもり',
  cloud: 'くもり',
  fog: '霧',
  rain: '雨',
  snow: '雪',
  sleet: 'みぞれ',
  thunder: '雷雨',
};

const CLOUD = 'M8 20h16a5 5 0 0 0 0-10 7 7 0 0 0-13.2-1.6A5.2 5.2 0 0 0 8 20z';
const SUN_RAYS = (cx: number, cy: number, r1: number, r2: number) =>
  Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const f = (n: number) => n.toFixed(1);
    return `<line x1="${f(cx + r1 * Math.cos(a))}" y1="${f(cy + r1 * Math.sin(a))}" x2="${f(cx + r2 * Math.cos(a))}" y2="${f(cy + r2 * Math.sin(a))}"/>`;
  }).join('');

/** 白黒の天気のマーク（32×32 の SVG を img の data: にする。古い Kindle のブラウザでも出るよう、HTML の中に SVG を直接書かない） */
export function iconImg(code: number, isDay: boolean, size: number): string {
  const k = kindOf(code);
  let body: string;
  const moon = '<path d="M19 5a11 11 0 1 0 8 17A9 9 0 0 1 19 5z"/>';
  const drops = (mark: 'rain' | 'snow' | 'sleet') =>
    [9, 16, 23]
      .map((x, i) =>
        (mark === 'snow' || (mark === 'sleet' && i === 1))
          ? `<circle cx="${x}" cy="26" r="1.8" fill="#000"/>`
          : `<line x1="${x + 1}" y1="23" x2="${x - 1.5}" y2="29"/>`,
      )
      .join('');
  switch (k) {
    case 'clear':
      body = isDay ? `<circle cx="16" cy="16" r="6"/>${SUN_RAYS(16, 16, 9, 13)}` : moon;
      break;
    case 'partly':
      body = (isDay ? `<circle cx="11" cy="11" r="4"/>${SUN_RAYS(11, 11, 6, 8.5)}` : '<path d="M10 3a7 7 0 1 0 5 11A6 6 0 0 1 10 3z"/>') +
        '<path fill="#fff" d="M11 27h13a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11-1.5A4.6 4.6 0 0 0 11 27z"/>';
      break;
    case 'cloud':
      body = `<path transform="translate(0 4)" d="${CLOUD}"/>`;
      break;
    case 'fog':
      body = '<line x1="5" y1="11" x2="27" y2="11"/><line x1="8" y1="17" x2="24" y2="17"/><line x1="5" y1="23" x2="27" y2="23"/>';
      break;
    case 'thunder':
      body = `<path d="${CLOUD}"/><path fill="#000" stroke="none" d="M17 20l-5 7h4l-2 5 6-8h-4l2-4z"/>`;
      break;
    default:
      body = `<path d="${CLOUD}"/>${drops(k)}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${size}" height="${size}" alt="${KIND_JA[k]}">`;
}

// ---- 取得と保存 ----

export class WeatherSource {
  data: Weather | null = null;
  file: string;
  latlon: string;
  constructor(file: string, latlon: string) {
    this.file = file;
    this.latlon = latlon;
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as Weather;
    } catch {
      /* まだ無い */
    }
  }

  async fetch(now = Date.now()) {
    if (!this.latlon) throw new Error('天気の場所が決まっていません（config.json の latlon）');
    const get = async (model?: string) => {
      const res = await fetch(omUrl(this.latlon, model));
      if (!res.ok) throw new Error(`Open-Meteo${model ? ` (${model})` : ''} ${res.status}`);
      const w = parseOpenMeteo((await res.json()) as OmResponse, now);
      if (!w) throw new Error('Open-Meteo: 形が違う');
      return w;
    };
    const base = await get();
    // 天気と気温は気象庁の計算で（既定の計算は、ほかでは出ていない霧を出した。2026-11-27）。取れなければ既定のまま
    const jma = await get('jma_seamless').catch((e) => {
      console.warn('[weather] 気象庁モデルを取れませんでした:', e instanceof Error ? e.message : e);
      return null;
    });
    const w = jma ? mergeJma(base, jma) : base;
    this.data = w;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(w));
  }
}

/**
 * 天気のマーク・気温・雪の降る量は気象庁の計算（jma）、降水確率と積雪の深さは既定（base）を使う（気象庁の計算には無いため）。
 * 気象庁の計算に値が無い時刻は既定のまま（2026-11-27）
 */
export function mergeJma(base: Weather, jma: Weather): Weather {
  const jh = new Map(jma.hourly.map((h) => [h.at, h]));
  const jd = new Map(jma.daily.map((d) => [d.at, d]));
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  return {
    fetchedAt: base.fetchedAt,
    current: ok(jma.current.temp) && ok(jma.current.code) ? jma.current : base.current,
    hourly: base.hourly.map((h) => {
      const j = jh.get(h.at);
      return j && ok(j.code) && ok(j.temp) ? { ...h, code: j.code, temp: j.temp, isDay: j.isDay, snow: ok(j.snow) ? j.snow : h.snow } : h;
    }),
    daily: base.daily.map((d) => {
      const j = jd.get(d.at);
      return j && ok(j.code) && ok(j.max) && ok(j.min) ? { ...d, code: j.code, max: j.max, min: j.min } : d;
    }),
  };
}

/** 翌朝 9 時（日本時間）までに降る雪（cm）と今の積雪（cm）。雪が無ければ null */
export function snowSummary(w: Weather, now: number): { until: number; cm: number; depth: number | null } | null {
  const JST = 9 * 3600_000;
  const DAY = 86400_000;
  const day0 = Math.floor((now + JST) / DAY) * DAY - JST;
  const nine = day0 + 9 * 3600_000;
  const until = now < nine ? nine : nine + DAY;
  const hourStart = Math.floor(now / 3600_000) * 3600_000;
  // snowfall はその時刻までの 1 時間に降った量
  const cm = w.hourly.filter((h) => h.at > hourStart && h.at <= until).reduce((a, h) => a + h.snow, 0);
  const cur = w.hourly.filter((h) => h.at <= now).at(-1);
  const depth = cur?.depth ?? null;
  if (cm < 0.5 && !(depth && depth >= 1)) return null;
  return { until, cm: Math.round(cm), depth: depth && depth >= 1 ? depth : null };
}
