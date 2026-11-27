// 価格のアラート（全部のプロジェクトで共通。2026-11-27）。
// それまでは水平線の図形としてプロジェクトの中に持ち、FP の画面が「今開いているプロジェクトの、今出している銘柄」だけを
// ライブの間に見ていたので、プロジェクトや銘柄を切り替えると鳴らなかった。
// ここでは開発サーバー（FX Practice を開いている間は動いている）が、T580 から届く全銘柄の価格でアラートを見張り、
// 届いたら Mac の通知を出して一覧から外し、開いている FP の画面に知らせる（FP は音と画面の知らせを出す）。
//
// 置き場所: プロジェクトの保存先の alerts.json（Dropbox。どの Mac でも同じ）
//   GET  /api/alerts            → { alerts: Alert[] }
//   PUT  /api/alerts/<銘柄>      { alerts: Alert[] } その銘柄のアラートを丸ごと置き換える（FP で置く・動かす・消すたび）
//   GET  /api/alerts/stream     Server-Sent Events。{ type: 'list', alerts } をつないだときと変わるたび、{ type: 'fired', alert, price } を鳴ったとき

import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export interface PriceAlert {
  id: string;
  /** 銘柄（小文字。usdjpy など） */
  sym: string;
  /** 価格 */
  p: number;
  /** 置いた所の時刻（UTC ミリ秒。チャートの線の点に使うだけ） */
  t: number;
  /** 置いた時間足と日時 */
  tf?: string;
  created?: number;
}

export interface AlertTick {
  bid: number;
  /** できかけの 1 分足 */
  bar: { t: number; h: number; l: number } | null;
}

export type AlertEvent = { type: 'list'; alerts: PriceAlert[] } | { type: 'fired'; alert: PriceAlert; price: number; title: string; body: string };

/** Mac の通知センターに出す（文字は引数で渡す。AppleScript の文の中に埋め込まない） */
export function macNotify(title: string, body: string) {
  execFile('osascript', [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
    '-e',
    'end run',
    title.slice(0, 200),
    body.slice(0, 500),
  ]);
}

/**
 * 前に届いた価格から今の価格までに通った幅（lo〜hi）。価格は数秒〜20 秒おきにしか届かないことがあるので、
 * その間に触って戻った分も、できかけの 1 分足の高値・安値が伸びた所で拾う（同じ足なら伸びた分だけ、新しい足ならその足の高値・安値）
 */
export function passedRange(prev: AlertTick | null, cur: AlertTick): { lo: number; hi: number } | null {
  if (!prev) return null;
  let lo = Math.min(prev.bid, cur.bid);
  let hi = Math.max(prev.bid, cur.bid);
  const b = cur.bar;
  const pb = prev.bar;
  if (b && pb) {
    if (pb.t === b.t) {
      if (b.h > pb.h) hi = Math.max(hi, b.h);
      if (b.l < pb.l) lo = Math.min(lo, b.l);
    } else if (b.t > pb.t) {
      hi = Math.max(hi, b.h);
      lo = Math.min(lo, b.l);
    }
  }
  return lo < hi ? { lo, hi } : null;
}

export class AlertBook {
  private alerts: PriceAlert[] = [];
  private loaded: Promise<void>;
  /** 銘柄 → 前に届いた価格 */
  private last = new Map<string, AlertTick>();
  /** 鳴らして外したアラート（古い画面が一覧を送り直しても、生き返らせない） */
  private fired = new Set<string>();
  readonly subs = new Set<(e: AlertEvent) => void>();

  constructor(
    readonly file: string,
    private notify: (title: string, body: string) => void = macNotify,
  ) {
    this.loaded = readFile(file, 'utf8')
      .then((s) => {
        const v = JSON.parse(s) as { alerts?: PriceAlert[] };
        this.alerts = Array.isArray(v.alerts) ? v.alerts.filter((a) => a && typeof a.id === 'string' && Number.isFinite(a.p)) : [];
      })
      .catch(() => {});
  }

  async list(): Promise<PriceAlert[]> {
    await this.loaded;
    return this.alerts;
  }

  private async save() {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ alerts: this.alerts }, null, 1));
    await rename(tmp, this.file);
  }

  private emit(e: AlertEvent) {
    for (const s of this.subs) s(e);
  }

  /** その銘柄のアラートを丸ごと置き換える */
  async replace(sym: string, list: PriceAlert[]) {
    await this.loaded;
    const mine = list
      .filter((a) => a && typeof a.id === 'string' && Number.isFinite(a.p) && !this.fired.has(a.id))
      .map((a) => ({ id: a.id, sym, p: a.p, t: Number.isFinite(a.t) ? a.t : Date.now(), ...(a.tf ? { tf: a.tf } : {}), ...(a.created ? { created: a.created } : {}) }));
    this.alerts = [...this.alerts.filter((a) => a.sym !== sym), ...mine];
    await this.save();
    this.emit({ type: 'list', alerts: this.alerts });
  }

  /** 価格が届いたとき。通った幅にアラートがあれば鳴らして外す */
  async check(sym: string, tick: AlertTick, digits = 5, label = sym.toUpperCase()) {
    await this.loaded;
    if (!(tick.bid > 0)) return;
    const range = passedRange(this.last.get(sym) ?? null, tick);
    this.last.set(sym, { bid: tick.bid, bar: tick.bar ? { t: tick.bar.t, h: tick.bar.h, l: tick.bar.l } : null });
    if (!range) return;
    const hit = this.alerts.filter((a) => a.sym === sym && a.p >= range.lo && a.p <= range.hi);
    if (!hit.length) return;
    this.alerts = this.alerts.filter((a) => !hit.includes(a));
    for (const a of hit) {
      this.fired.add(a.id);
      const lv = a.p.toFixed(digits);
      const title = `${label} ${lv}`;
      const body = `価格が ${lv} に届きました（今 ${tick.bid.toFixed(digits)}）`;
      this.notify(title, body);
      this.emit({ type: 'fired', alert: a, price: tick.bid, title, body });
    }
    await this.save();
    this.emit({ type: 'list', alerts: this.alerts });
  }

  /** /api/alerts の入口 */
  async handle(req: IncomingMessage, res: ServerResponse, sub: string) {
    const json = (status: number, v: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(v));
    };
    if (sub === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const send = (e: AlertEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ type: 'list', alerts: await this.list() });
      this.subs.add(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        this.subs.delete(send);
      });
      return;
    }
    if (req.method === 'GET' && (sub === '' || sub === '/')) return json(200, { alerts: await this.list() });
    const m = /^\/([a-z0-9]+)$/.exec(sub);
    if (req.method === 'PUT' && m) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { alerts?: PriceAlert[] };
      await this.replace(m[1], Array.isArray(b.alerts) ? b.alerts : []);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }
}

export const alertsFile = (projectDir: string) => path.join(projectDir, 'alerts.json');
