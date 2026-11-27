// Kindle に送る画像（2026-11-27）。脱獄した Kindle Paperwhite 2 が数分ごとに取りに来て、全画面に出す。
//   1. renderKindle の HTML をファイルに書く
//   2. Chrome（ヘッドレス）で 1024×758 に撮る
//   3. sips で 90°（か 270°）回して 758×1024 の白黒（8 bit グレー）にする（Kindle の画面は縦向きなので、横に置いて見るため）
// 1 枚作るのに 2〜5 秒。60 秒以内に作ったものはそのまま返す。
//
// Kindle（Wi-Fi）から取りに来る入口: 家のネットワークの 8090 番（環境変数 FXP_KINDLE_PORT。0 で止める）。
//   受け付けるのは GET /kindle.png だけ（?rot=270 で逆向き。?batt=67&chg=1&hold=0 で電池の残量・充電中・充電を止めているかを伝えると、画面の右上に出し、
//   Dropbox の Claude/kindle_dashboard/battery.csv に記録する）。プロジェクトなどの API はほかの機器に開かない。

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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
 *   charging.svg（か .png）     充電中のマーク
 *   config.json                { "latlon": "緯度,経度" } 天気の場所（住んでいる場所なので、公開しているリポジトリには書かない）
 */
export const KINDLE_DIR = process.env.FXP_KINDLE_DIR || '/Users/ryo/Library/CloudStorage/Dropbox/Claude/kindle_dashboard';

/**
 * 充電中のマーク。自分で用意した画像を KINDLE_DIR の charging.svg（か .png）に置くと、充電中に電池の残量の横に出す。
 * キャラクターの絵などを使うので、git には入れずにここに置く。無ければ「充電中」と字で出す
 */
export function chargingIcon(dir = KINDLE_DIR): string | null {
  for (const [name, type] of [['charging.svg', 'image/svg+xml'], ['charging.png', 'image/png']] as const) {
    try {
      return `data:${type};base64,${readFileSync(path.join(dir, name)).toString('base64')}`;
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

  /** Kindle が伝えてきた電池の残量を覚えて記録する（?batt=67&chg=1&hold=0）。変わっていれば画像を作り直す */
  async report(q: URLSearchParams, now = Date.now()) {
    const level = Number(q.get('batt'));
    if (!q.has('batt') || !Number.isFinite(level) || level < 0 || level > 100) return;
    const charging = q.get('chg') === '1';
    const held = q.get('hold') === '1';
    const changed = !this.battery || this.battery.level !== level || this.battery.charging !== charging || !!this.battery.held !== held;
    this.battery = { level, charging, held, at: now };
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
    await mkdir(this.dir, { recursive: true });
    const html = path.join(this.dir, 'kindle.html');
    const shot = path.join(this.dir, 'shot.png');
    await writeFile(html, this.makeHtml());
    await run(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        // ふだん使っている Chrome とは別の置き場（開いていてもぶつからないように）
        `--user-data-dir=${path.join(this.dir, 'chrome')}`,
        '--window-size=1024,758',
        `--screenshot=${shot}`,
        `file://${html}`,
      ],
      { timeout: 60_000 },
    );
    for (const rot of [90, 270] as const) {
      await run('sips', ['-r', String(rot), '-m', GRAY, shot, '--out', this.file(rot)], { timeout: 30_000 });
    }
  }
}

/** Kindle から取りに来る入口（家のネットワーク。GET /kindle.png だけ） */
export function startKindleServer(img: KindleImage, port = Number(process.env.FXP_KINDLE_PORT ?? 8090)): Server | null {
  if (!port) return null;
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (req.method !== 'GET' || u.pathname !== '/kindle.png') {
      res.statusCode = 404;
      return res.end();
    }
    const rot: Rotation = u.searchParams.get('rot') === '270' ? 270 : 90;
    img
      .report(u.searchParams)
      .then(() => img.png(rot))
      .then(
      (b) => {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(b);
      },
      (e) => {
        console.warn('[kindle]', e instanceof Error ? e.message : e);
        res.statusCode = 500;
        res.end();
      },
    );
  });
  // 開発サーバーが自分で起動し直したときは前の入口が閉じる前に来るので、使われていたら 3 秒おきに開き直す（価格の受け口と同じ）
  let tries = 0;
  srv.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && tries++ < 100) {
      setTimeout(() => srv.listen(port, '0.0.0.0'), 3000).unref();
      return;
    }
    console.warn(`[kindle] Kindle の入口 ${port} 番を開けませんでした: ${e.message}`);
  });
  srv.listen(port, '0.0.0.0');
  srv.unref();
  return srv;
}
