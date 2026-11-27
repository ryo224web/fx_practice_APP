// Kindle に送る画像（2026-11-27）。脱獄した Kindle Paperwhite 2 が数分ごとに取りに来て、全画面に出す。
//   1. renderKindle の HTML をファイルに書く
//   2. Chrome（ヘッドレス）で 1024×758 に撮る
//   3. sips で 90°（か 270°）回して 758×1024 の白黒（8 bit グレー）にする（Kindle の画面は縦向きなので、横に置いて見るため）
// 1 枚作るのに 2〜5 秒。60 秒以内に作ったものはそのまま返す。
// Kindle から取りに来る入口は server/kindleServer.ts（FX Practice とは別に、いつも動かしておくサーバー）。

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const CHROME = process.env.FXP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GRAY = '/System/Library/ColorSync/Profiles/Generic Gray Gamma 2.2 Profile.icc';
const FRESH_MS = 60_000;

export type Rotation = 90 | 270;

/**
 * Kindle のダッシュボードのデータの置き場（FX Practice とは別。2026-11-27）。環境変数 FXP_KINDLE_DIR で変えられる
 *   calendar/<日曜の日付>.json  取ってきた経済指標（週ごと）
 *   weather.json               最後に取った天気
 *   battery.csv                Kindle の電池の記録（日時,残量,充電中,充電を止めている）
 *   charging.png・normal.png    電池の残量の横に出す絵（充電中・ふだん。自分で置いた画像をそのまま出す）
 *   config.json                { "latlon": "緯度,経度" } 天気の場所（住んでいる場所なので、公開しているリポジトリには書かない）
 */
export const KINDLE_DIR = process.env.FXP_KINDLE_DIR || '/Users/ryo/Library/CloudStorage/Dropbox/Claude/kindle_dashboard';

/**
 * 電池の残量の横に出す絵。KINDLE_DIR に自分で置いた画像をそのまま出す（描き直さない）。
 *   charging.png（か .svg・.jpg）  充電中
 *   normal.png（か .svg・.jpg）    ふだん（充電していないとき）
 * キャラクターの絵などを使うので、git には入れずにここに置く。無ければ出さない（充電中は「充電中」と字で出す）
 */
export function batteryIcon(name: 'charging' | 'normal', dir = KINDLE_DIR): string | null {
  for (const [ext, type] of [['png', 'image/png'], ['svg', 'image/svg+xml'], ['jpg', 'image/jpeg']] as const) {
    try {
      return `data:${type};base64,${readFileSync(path.join(dir, `${name}.${ext}`)).toString('base64')}`;
    } catch {
      /* 無ければ次 */
    }
  }
  return null;
}

export interface Battery {
  level: number;
  charging: boolean;
  /** ケーブルは挿してあるが、電池を守るため充電を止めている（80% で止め 40% で再開） */
  held?: boolean;
  /** ケーブルが挿さっている（充電中か、充電を止めている） */
  plugged?: boolean;
  /** 伝えてきた時刻 */
  at: number;
}

/** Kindle の電池の記録（日時,残量,充電中,充電を止めている）。1 日に何 % 減るかを見るため */
export const BATTERY_LOG = path.join(KINDLE_DIR, 'battery.csv');

export class KindleImage {
  dir: string;
  makeHtml: () => string;
  private busy: Promise<void> | null = null;
  battery: Battery | null = null;
  constructor(dir: string, makeHtml: () => string) {
    this.dir = dir;
    this.makeHtml = makeHtml;
  }

  /** Kindle が伝えてきた電池の残量を覚えて記録する（?batt=67&chg=1&hold=0&plug=1）。変わっていれば画像を作り直す */
  async report(q: URLSearchParams, now = Date.now()) {
    const level = Number(q.get('batt'));
    if (!q.has('batt') || !Number.isFinite(level) || level < 0 || level > 100) return;
    const charging = q.get('chg') === '1';
    const held = q.get('hold') === '1';
    const plugged = q.get('plug') === '1' || charging;
    const changed = !this.battery || this.battery.level !== level || this.battery.charging !== charging || !!this.battery.held !== held || !!this.battery.plugged !== plugged;
    this.battery = { level, charging, held, plugged, at: now };
    const t = new Date(now + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    await appendFile(BATTERY_LOG, `${t},${level},${charging ? 1 : 0},${held ? 1 : 0}\n`).catch(() => {});
    if (changed) this.staleAt = now;
  }
  /** これより前に作った画像は古いとみなす */
  private staleAt = 0;

  file(rot: Rotation) {
    return path.join(this.dir, `kindle_${rot}.png`);
  }

  /** 作ってから 60 秒以内ならそのまま、古ければ作り直して返す */
  async png(rot: Rotation): Promise<Buffer> {
    const f = this.file(rot);
    const made = await stat(f).then((s) => s.mtimeMs, () => 0);
    if (Date.now() - made > FRESH_MS || made < this.staleAt) await this.render();
    return readFile(f);
  }

  /** 作る（同時に頼まれたら 1 回にまとめる） */
  render(): Promise<void> {
    this.busy ??= this.doRender().finally(() => (this.busy = null));
    return this.busy;
  }

  private async doRender() {
    await this.shoot(this.makeHtml(), 1024, 758, (rot) => this.file(rot));
  }

  /** HTML を Chrome で w×h に撮って、90°・270° 回した白黒の PNG にする */
  private async shoot(page: string, w: number, h: number, out: (rot: Rotation) => string) {
    await mkdir(this.dir, { recursive: true });
    const html = path.join(this.dir, 'page.html');
    const shot = path.join(this.dir, 'shot.png');
    await writeFile(html, page);
    await run(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        // ふだん使っている Chrome とは別の置き場（開いていてもぶつからないように）
        `--user-data-dir=${path.join(this.dir, 'chrome')}`,
        `--window-size=${w},${h}`,
        `--screenshot=${shot}`,
        `file://${html}`,
      ],
      { timeout: 60_000 },
    );
    for (const rot of [90, 270] as const) {
      await run('sips', ['-r', String(rot), '-m', GRAY, shot, '--out', out(rot)], { timeout: 30_000 });
    }
  }

  /**
   * 「Mac mini お休み中」の帯（横 1024×縦 50 を回したもの）。Mac mini が寝ていて画像を取れないとき、Kindle が前の画面の上端に重ねる（2026-11-27 に下端から変えた）。
   * 中身は変わらないので 1 回だけ作る（Kindle は起きている間に 1 回取って持っておく）
   */
  async banner(rot: Rotation): Promise<Buffer> {
    const out = (r: Rotation) => path.join(this.dir, `banner_v2_${r}.png`);
    const made = await stat(out(rot)).then(() => true, () => false);
    if (!made) {
      this.busy = (this.busy ?? Promise.resolve())
        .then(() =>
          this.shoot(
            `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#000;color:#fff;font-family:"Hiragino Sans",sans-serif;height:50px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:bold}</style></head><body>Mac mini お休み中　（Mac が起きたら 5 分以内に新しい画面に戻ります）</body></html>`,
            1024,
            50,
            out,
          ),
        )
        .finally(() => (this.busy = null));
      await this.busy;
    }
    return readFile(out(rot));
  }
}
