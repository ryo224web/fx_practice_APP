// 気象庁の警報・注意報（2026-11-27）。Kindle の一番上の行に、出ているときだけ「大雪注意報」などと出す。
// 取ってくる先: https://www.jma.go.jp/bosai/warning/data/r8/<府県予報区のコード>.json（鍵は要らない。15 分に 1 回）。
//   2026-05-28 に気象庁の防災気象情報が新しくなり、それまでの data/warning/<コード>.json は更新されなくなった（r8 が新しい置き場所）。
//   中身は要素ごと（雨・風・波など）の最新の発表の並び。全部を見て、市町村（class20）の「発表」「継続」の種類を集める。
// 府県予報区と市町村のコードは、データの置き場の config.json の jmaOffice・jmaArea（住んでいる場所なので、公開しているリポジトリには書かない）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 警報・注意報の種類（気象庁のコード） */
export const WARNING_NAMES: Record<string, string> = {
  '02': '暴風雪警報',
  '03': '大雨警報',
  '04': '洪水警報',
  '05': '暴風警報',
  '06': '大雪警報',
  '07': '波浪警報',
  '08': '高潮警報',
  '10': '大雨注意報',
  '12': '大雪注意報',
  '13': '風雪注意報',
  '14': '雷注意報',
  '15': '強風注意報',
  '16': '波浪注意報',
  '17': '融雪注意報',
  '18': '洪水注意報',
  '19': '高潮注意報',
  '20': '濃霧注意報',
  '21': '乾燥注意報',
  '22': 'なだれ注意報',
  '23': '低温注意報',
  '24': '霜注意報',
  '25': '着氷注意報',
  '26': '着雪注意報',
  '32': '暴風雪特別警報',
  '33': '大雨特別警報',
  '35': '暴風特別警報',
  '36': '大雪特別警報',
  '37': '波浪特別警報',
  '38': '高潮特別警報',
};

export interface Warnings {
  fetchedAt: number;
  /** 出ている警報・注意報の名前（特別警報・警報を先に） */
  active: string[];
}

interface Report {
  reportDatetime?: string;
  warning?: { class20Items?: { areaCode: string; kinds: { code?: string; status: string }[] }[] };
}

/** その市町村で今出ている（発表・継続）警報・注意報の名前 */
export function activeWarnings(reports: unknown, area: string): string[] {
  if (!Array.isArray(reports)) return [];
  const codes = new Set<string>();
  for (const r of reports as Report[]) {
    for (const it of r.warning?.class20Items ?? []) {
      if (it.areaCode !== area) continue;
      for (const k of it.kinds) if (k.code && (k.status === '発表' || k.status === '継続')) codes.add(k.code);
    }
  }
  const name = (c: string) => WARNING_NAMES[c] ?? `警報等（${c}）`;
  // 雪と大雨に関係するものと、特別警報だけ（雷・融雪・強風などは要らないと言われた。2026-11-27）
  const wanted = (n: string) => n.includes('特別警報') || /大雨|大雪|暴風雪|風雪|着雪/.test(n);
  const rank = (n: string) => (n.includes('特別警報') ? 0 : n.includes('警報') ? 1 : 2);
  return [...codes].map(name).filter(wanted).sort((a, b) => rank(a) - rank(b));
}

export class WarningSource {
  data: Warnings | null = null;
  file: string;
  office: string;
  area: string;
  constructor(file: string, office: string, area: string) {
    this.file = file;
    this.office = office;
    this.area = area;
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as Warnings;
    } catch {
      /* まだ無い */
    }
  }

  async fetch(now = Date.now()) {
    if (!this.office || !this.area) throw new Error('警報の地域が決まっていません（config.json の jmaOffice・jmaArea）');
    const res = await fetch(`https://www.jma.go.jp/bosai/warning/data/r8/${this.office}.json`);
    if (!res.ok) throw new Error(`気象庁の警報 ${res.status}`);
    this.data = { fetchedAt: now, active: activeWarnings(await res.json(), this.area) };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data));
  }
}
