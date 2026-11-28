// Kindle のダッシュボードの片付け（2026-11-28）。ゴミをためないように、起動したときと 1 日に 1 回、要らないファイルを消す。
//   作業場所（OS の一時フォルダの fxp-kindle）: 今の版でない帯（banner_v<古い>_*.png）・使っていないファイルを消し、Chrome の作業用フォルダを空にする
//   データの置き場（KINDLE_DIR）: calendar/ は 8 週より前の週を消す。battery.csv は 90 日より前の行を消す
//   サーバーの記録（~/Library/Logs/kindle-dashboard.log）: 1 MB を超えたら後ろ半分だけ残す
// 自分で置いた画像（charging.png・normal.png など）や config.json には触らない。

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 作業場所に残してよいファイル（それ以外は消す）。帯は今の版だけ */
export function keepWorkFile(name: string, bannerVersion: string): boolean {
  if (/^kindle_(90|270)\.png$/.test(name)) return true;
  if (name === 'page.html' || name === 'shot.png' || name === 'battery_pending.csv') return true;
  return name.startsWith(`banner_${bannerVersion}_`);
}

/** battery.csv の、cutoff（"YYYY-MM-DD HH:MM:SS" の文字）より前の行を除く */
export function trimBatteryCsv(text: string, cutoff: string): string {
  return text
    .split('\n')
    .filter((l) => l && l.slice(0, 19) >= cutoff)
    .map((l) => `${l}\n`)
    .join('');
}

export async function cleanup(opts: { workDir: string; dataDir: string; bannerVersion: string; now?: number; logFile?: string }) {
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  // 作業場所
  for (const name of await readdir(opts.workDir).catch(() => [] as string[])) {
    const p = path.join(opts.workDir, name);
    if (name === 'chrome') {
      await rm(p, { recursive: true, force: true });
      continue;
    }
    if (!keepWorkFile(name, opts.bannerVersion)) {
      await rm(p, { recursive: true, force: true });
      removed.push(name);
    }
  }
  // 指標: 8 週より前
  const calDir = path.join(opts.dataDir, 'calendar');
  const weekCut = new Date(now - 56 * 86400_000).toISOString().slice(0, 10);
  for (const name of await readdir(calDir).catch(() => [] as string[])) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < weekCut) {
      await rm(path.join(calDir, name), { force: true });
      removed.push(`calendar/${name}`);
    }
  }
  // 電池の記録: 90 日より前の行
  const csv = path.join(opts.dataDir, 'battery.csv');
  const text = await readFile(csv, 'utf8').catch(() => null);
  if (text) {
    const cut = new Date(now + 9 * 3600_000 - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const kept = trimBatteryCsv(text, cut);
    if (kept.length < text.length) {
      await writeFile(csv, kept);
      removed.push(`battery.csv の古い行 ${text.split('\n').filter(Boolean).length - kept.split('\n').filter(Boolean).length} 行`);
    }
  }
  // サーバーの記録: 1 MB を超えたら後ろ半分
  const log = opts.logFile ?? path.join(os.homedir(), 'Library/Logs/kindle-dashboard.log');
  const size = await stat(log).then((s) => s.size, () => 0);
  if (size > 1_000_000) {
    const t = await readFile(log, 'utf8');
    await writeFile(log, t.slice(t.length / 2));
    removed.push('kindle-dashboard.log の前半');
  }
  if (removed.length) console.log(`${new Date(now).toISOString()} [cleanup] 消しました: ${removed.join(', ')}`);
  return removed;
}
