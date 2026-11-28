// プロジェクトをフォルダにファイルで保存する（開発サーバーに組み込む）。
// ブラウザは外のフォルダに書けないので、アプリを動かしているサーバーが代わりに読み書きする。
//
//   <dir>/index.json                              今開いているプロジェクトと並び順（ID で持つ）
//   <dir>/projects/<フォルダ…>/<名前>.fxp.json      プロジェクト 1 つ（「ファイルに書き出す」と同じ形式。中に ID も入れる）
//   <dir>/projects/.locks/<ID>.json               どの Mac が開いているか（別の Mac で同時に開かないための目印）
//   <dir>/templates/<名前>.fxt.json                定型（チャートの並べ方・インジケーター・色など。プロジェクトに当てる）
//   <dir>/templates/_settings.json                新しいプロジェクトに使う定型の名前
//   <dir>/settings.json                           全部のプロジェクトで共通の設定（キーボードのショートカット。/api/settings）
//   <dir>/screenshots/<プロジェクト名>/<日時>_<銘柄>_<時間足>.png   ツールバーの 📷 で撮ったチャート（/api/screenshots）
//   <dir>/backups/<ID>/<日時>.fxp.json             上書き・削除する前の控え（10 分に 1 回まで、プロジェクトごとに 30 個。「ファイルから読み込む」で戻せる）
//
// 書く前・消す前に、そのファイルの中の ID が本当にそのプロジェクトかを確かめる（Finder や Dropbox がファイルを動かしても、
// ほかのプロジェクトのファイルを上書きしたり消したりしないため。2026-10-22 にこれで 1 つ消えた）。
//
// ファイル名はプロジェクトの名前。名前を変えるとファイル名も変わる。同じフォルダに同じ名前があれば「名前 (2)」のようにする。
// フォルダ（"MT4/GOLD/2026"）は、ファイルの置き場所そのもの。アプリでフォルダを変えるとファイルが移り、
// Finder でファイルを別のフォルダへ動かすと、アプリの一覧のフォルダも変わる。空のフォルダも一覧に出す（先にフォルダを作れるように）。
//   POST   /folders          { path }        フォルダを作る
//   PUT    /folders          { from, to }    フォルダの名前を変える・動かす（中のプロジェクトごと）
//   DELETE /folders?path=…                   空のフォルダを消す（プロジェクトが入っていれば消さない）
// 保存先は環境変数 FXP_PROJECT_DIR で変えられる。

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';

export const DEFAULT_PROJECT_DIR = '/Users/ryo/Library/CloudStorage/Dropbox/Claude/fx_practice';

const ID = /^[A-Za-z0-9-]{1,64}$/;
const EXT = '.fxp.json';

interface ProjectFile {
  format: 'fx-practice-project';
  version: 1;
  /** 以前の形式（ファイル名が ID）では無い */
  id?: string;
  name: string;
  updated: number;
  state: unknown;
}

/** ファイル名に使えない文字を _ にする（Mac・Windows・Dropbox のどれでも使えるように） */
export function safeFileName(name: string): string {
  const s = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return s || 'プロジェクト';
}

/** taken（小文字にしたファイル名）とぶつからないファイル名。ぶつかれば「名前 (2)」「名前 (3)」… */
export function uniqueFileName(name: string, taken: Set<string>): string {
  const base = safeFileName(name);
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? base : `${base} (${n})`}${EXT}`;
    if (!taken.has(file.toLowerCase())) return file;
  }
}

/** "MT4 / GOLD//2026 " → "MT4/GOLD/2026"（段ごとにファイル名に使えない文字を除く） */
export function safeFolder(folder: string): string {
  return folder
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(safeFileName)
    .join('/');
}

/** "MT4/GOLD/2026/GOLD 2026 09.fxp.json" → "MT4/GOLD/2026" */
const folderOf = (rel: string) => {
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
};

/**
 * 保存先が読めない（Mac が Dropbox を読む許可を外した・Dropbox がまだ落としていない・ファイルが壊れている、など）。
 * このときは何も書かずに止める（503）。
 * 2026-11-28 に、Mac が node に Dropbox を読ませなくなったのに、読めないのを「ファイルが無い」と同じに扱っていたので、
 * サーバーは保存先が空だと思い込み、FP はブラウザの中のプロジェクトをフォルダの外に書き出し、共通の設定もほぼ空で書き直しかけた
 * （置き換えの最後で失敗したので無事だった）。「無い」と言ってよいのは、本当に無い（ENOENT）ときだけ
 */
export class StoreUnreadable extends Error {
  readonly code = 'store-unreadable';
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR';

function unreadable(file: string, e: unknown): StoreUnreadable {
  const code = (e as NodeJS.ErrnoException)?.code;
  const why =
    code === 'EPERM' || code === 'EACCES'
      ? 'Mac が読むのを許可していません（システム設定のプライバシーとセキュリティで、node か FX Practice に Dropbox を読む許可が要ります）'
      : e instanceof SyntaxError
        ? '中身が壊れているか、Dropbox がまだ書き終えていません'
        : `${code ?? (e instanceof Error ? e.message : String(e))}`;
  return new StoreUnreadable(`保存先の ${path.basename(file)} を読めません: ${why}`);
}

/** JSON を読む。無ければ null。読めない・壊れているときは StoreUnreadable（「無い」とは扱わない） */
export async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw unreadable(file, e);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw unreadable(file, e);
  }
}

/** フォルダの中身。無ければ空。読めないときは StoreUnreadable */
async function listDir(d: string): Promise<string[]> {
  try {
    return await readdir(d);
  } catch (e) {
    if (isMissing(e)) return [];
    throw unreadable(d, e);
  }
}

async function listDirEntries(d: string) {
  try {
    return await readdir(d, { withFileTypes: true });
  } catch (e) {
    if (isMissing(e)) return [];
    throw unreadable(d, e);
  }
}

/**
 * 保存先そのものが読めるか。フォルダが無い（Dropbox の場所が変わった・外した）ときも止める
 * （mkdir で作り直すと、空の保存先に新しく書き始めてしまうため）
 */
export async function assertStoreReadable(dir: string) {
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('フォルダではありません');
    await readdir(dir);
  } catch (e) {
    if (isMissing(e)) throw new StoreUnreadable(`保存先のフォルダ（${dir}）がありません。Dropbox の場所が変わっていないか確かめてください`);
    throw unreadable(dir, e);
  }
  // 中の大事なファイルも読めるか（フォルダは見えても、中のファイルだけ読めないことがある）
  await readJson(path.join(dir, 'index.json'));
  await readJson(path.join(dir, 'settings.json'));
}

/** 書きかけのファイルが同期されないように、別名で書いてから置き換える */
async function writeJson(file: string, value: unknown) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

/** うまくいかなかったときの返事。保存先が読めないときは 503 と code で知らせる（FP は保存を止めて帯を出す） */
function fail(res: ServerResponse, e: unknown) {
  if (e instanceof StoreUnreadable) {
    console.warn(`[fxp-store] ${e.message}`);
    return send(res, 503, { error: e.message, code: e.code });
  }
  return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
}

export function projectStore(dir = process.env.FXP_PROJECT_DIR || DEFAULT_PROJECT_DIR): Plugin {
  const projects = path.join(dir, 'projects');
  const locks = path.join(projects, '.locks');
  const indexFile = path.join(dir, 'index.json');
  const host = os.hostname();
  /**
   * 開いている機器の名前。Tailscale（tailscale serve）を通して iPad などから開いたときは、サーバーは同じ Mac なので
   * 名前だけでは見分けられない。中継が付ける送り元のアドレスを足して、Mac mini で開いているのと別の機器として扱う
   */
  const hostOf = (req: IncomingMessage) => {
    const from = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(from) ? from[0] : from)?.split(',')[0].trim();
    return ip ? `Tailscale の機器（${ip}）` : host;
  };
  const lockOf = (id: string) => path.join(locks, `${id}.json`);
  const touchLock = (id: string, req: IncomingMessage) => writeJson(lockOf(id), { host: hostOf(req), time: Date.now() });
  /** ID → ファイル（projects からの相対パス。"/" 区切り）。毎回フォルダ中のファイルを読まないように覚えておく */
  const files = new Map<string, string>();
  const abs = (rel: string) => path.join(projects, ...rel.split('/'));

  /** projects の中の .fxp.json を、フォルダの中まで探す（"." で始まるフォルダ = .locks などは見ない） */
  async function walk(rel = ''): Promise<string[]> {
    const out: string[] = [];
    const entries = await listDirEntries(rel ? abs(rel) : projects);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name.normalize('NFC')}` : e.name.normalize('NFC');
      if (e.isDirectory()) out.push(...(await walk(r)));
      else if (e.name.endsWith(EXT)) out.push(r);
    }
    return out;
  }

  /** projects の中のフォルダ（"." で始まるものは見ない。空のフォルダも） */
  async function walkDirs(rel = ''): Promise<string[]> {
    const out: string[] = [];
    const entries = await listDirEntries(rel ? abs(rel) : projects);
    for (const e of entries) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name.normalize('NFC')}` : e.name.normalize('NFC');
      out.push(r, ...(await walkDirs(r)));
    }
    return out;
  }

  /** フォルダの中を消す（中にプロジェクトがあれば何もしないで false。.DS_Store などは消す） */
  async function removeIfEmpty(rel: string): Promise<boolean> {
    if ((await walk(rel)).length) return false;
    await rm(abs(rel), { recursive: true, force: true });
    return true;
  }

  const backups = path.join(dir, 'backups');
  /** ID → 最後に控えを取った時刻 */
  const lastBackup = new Map<string, number>();
  const BACKUP_EVERY = 10 * 60_000;
  const BACKUP_KEEP = 30;

  /** rel のファイルが、本当に id のプロジェクトか */
  async function holds(rel: string, id: string): Promise<boolean> {
    return (await readJson<ProjectFile>(abs(rel)))?.id === id;
  }

  /** 上書き・削除する前の控え。force でなければ 10 分に 1 回まで。古いものから消して 30 個まで残す */
  async function backup(id: string, rel: string, force = false) {
    const now = Date.now();
    if (!force && now - (lastBackup.get(id) ?? 0) < BACKUP_EVERY) return;
    const p = await readJson<ProjectFile>(abs(rel));
    if (!p || p.id !== id) return;
    const d = path.join(backups, id);
    await mkdir(d, { recursive: true });
    // 名前は控えを取った日時（ミリ秒まで。同じ秒に 2 つ取っても上書きしない）
    const stamp = new Date(now).toISOString().replace(/[:T]/g, '-').replace('Z', '');
    await copyFile(abs(rel), path.join(d, `${stamp}${EXT}`)).catch(() => {});
    lastBackup.set(id, now);
    const old = (await readdir(d).catch(() => [] as string[])).filter((f) => f.endsWith(EXT)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) await unlink(path.join(d, f)).catch(() => {});
  }

  /**
   * フォルダを読み直して ID とファイルの対応を作る。
   * 以前の形式（ファイル名が ID）のファイルは、名前のファイル名に付け替える。
   * 同じ ID のファイルが 2 つあれば（Finder でコピーした、など）、新しく保存した方を使う（もう一方は消さずに残す）
   */
  /** 読めなかったプロジェクトのファイル（壊れている・Dropbox が書きかけ）。どのプロジェクトか分からないので、見つからないプロジェクトは新しく書かない */
  let broken: string[] = [];

  async function scan(): Promise<{ id: string; name: string; updated: number; folder: string }[]> {
    const rels = await walk();
    files.clear();
    broken = [];
    const taken = new Set(rels.map((f) => f.toLowerCase()));
    const found = new Map<string, { id: string; name: string; updated: number; folder: string }>();
    for (const f of rels) {
      let p: ProjectFile | null;
      try {
        p = await readJson<ProjectFile>(abs(f));
      } catch (e) {
        // 1 つだけ壊れている（中身が JSON でない）なら、ほかは使えるように飛ばす。許可が無いなどで読めないなら止める
        if (e instanceof StoreUnreadable && /壊れている/.test(e.message)) {
          console.warn(`[fxp-store] ${e.message}`);
          broken.push(f);
          continue;
        }
        throw e;
      }
      if (!p) continue;
      let file = f;
      let id = p.id;
      if (!id) {
        id = path.posix.basename(f).slice(0, -EXT.length);
        if (!ID.test(id)) continue;
        taken.delete(f.toLowerCase());
        const dir = folderOf(f);
        const name = uniqueFileName(p.name, new Set([...taken].filter((t) => folderOf(t) === dir.toLowerCase()).map((t) => path.posix.basename(t))));
        file = dir ? `${dir}/${name}` : name;
        await writeJson(abs(file), { ...p, id });
        if (file !== f) await unlink(abs(f));
        // 以前の場所の目印も移す
        await rename(path.join(projects, `${id}.lock.json`), lockOf(id)).catch(() => {});
      }
      taken.add(file.toLowerCase());
      const prev = found.get(id);
      if (prev && prev.updated >= (p.updated ?? 0)) continue;
      files.set(id, file);
      found.set(id, { id, name: p.name, updated: p.updated, folder: folderOf(file) });
    }
    return [...found.values()];
  }

  /** id のファイル。覚えている場所に無い・中身が別のプロジェクトなら、読み直して探す */
  async function fileOf(id: string): Promise<string | null> {
    const known = files.get(id);
    if (known && (await holds(known, id))) return known;
    await scan();
    return files.get(id) ?? null;
  }

  /** dir（projects からの相対）に今あるファイル名（小文字） */
  async function namesIn(d: string): Promise<Set<string>> {
    const list = await listDir(d ? abs(d) : projects);
    return new Set(list.map((f) => f.normalize('NFC').toLowerCase()));
  }

  /** プロジェクトを書く。名前が変わっていればファイル名も変え、folder を渡せばそのフォルダへ移す（undefined なら今のフォルダのまま） */
  async function put(id: string, value: Omit<ProjectFile, 'format' | 'version' | 'id'>, folder?: string, existing = false) {
    const current = await fileOf(id);
    // 前からあるはずのプロジェクト（画面が読んだことがある・一覧に載っている）なのにファイルが見つからなければ、新しく書かない
    // （Dropbox が入れ替えている途中・読めないファイルがある、など。新しく書くと同じプロジェクトのファイルが 2 つになる）
    if (!current && (existing || broken.length)) {
      throw new StoreUnreadable(
        broken.length
          ? `保存先に読めないプロジェクトのファイルがあるので、新しいファイルは書きません（${broken.join('、')}）`
          : 'このプロジェクトのファイルが保存先に見つかりません。新しいファイルは書きません（Dropbox が入れ替えている途中かもしれません）',
      );
    }
    const dir = folder === undefined ? (current ? folderOf(current) : '') : safeFolder(folder);
    const wanted = safeFileName(value.name);
    let file = current;
    const sameName = current && path.posix.basename(current).normalize('NFC').toLowerCase().replace(/ \(\d+\)(?=\.fxp\.json$)/, '') === `${wanted}${EXT}`.toLowerCase();
    if (!current || !sameName || folderOf(current) !== dir) {
      // 同じフォルダの中でぶつからない名前にする（覚えている一覧ではなく、実際にあるファイルで見る）
      const taken = await namesIn(dir);
      if (current && folderOf(current).toLowerCase() === dir.toLowerCase()) taken.delete(path.posix.basename(current).toLowerCase());
      const name = uniqueFileName(value.name, taken);
      file = dir ? `${dir}/${name}` : name;
    }
    if (current) await backup(id, current);
    if (dir) await mkdir(abs(dir), { recursive: true });
    // 書く先に別のプロジェクトのファイルがあれば（上の名前の確かめと書くまでの間に置かれた、など）書かない
    const there = await readJson<ProjectFile>(abs(file!));
    if (there && there.id !== id) throw new Error(`${file} は別のプロジェクトのファイルなので上書きしません`);
    await writeJson(abs(file!), { format: 'fx-practice-project', version: 1, id, ...value } satisfies ProjectFile);
    // 元の場所のファイルは、中身がこのプロジェクトのときだけ消す
    // （元のフォルダは空になっても残す。消すのは一覧の 🗑 から）
    if (current && current !== file && (await holds(current, id))) await unlink(abs(current)).catch(() => {});
    files.set(id, file!);
  }

  /** 一覧に載っている（index.json にある）プロジェクトか */
  async function listed(id: string): Promise<boolean> {
    const idx = await readJson<{ order?: string[]; folders?: Record<string, string> }>(indexFile);
    return !!idx && ((idx.order ?? []).includes(id) || !!idx.folders?.[id]);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    await assertStoreReadable(dir);
    await mkdir(locks, { recursive: true });
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // 一覧
    if (parts.length === 0 && req.method === 'GET') {
      const list = await scan();
      const idx = await readJson(indexFile);
      const folders = await walkDirs();
      // 本当に初めて（一覧もプロジェクトもフォルダも無い）のときだけ fresh。FP はこのときだけブラウザの中のプロジェクトを移す
      const fresh = !idx && !list.length && !folders.length && !broken.length;
      return send(res, 200, { dir, host: hostOf(req), index: idx, projects: list, folders, fresh });
    }

    // フォルダ
    if (parts[0] === 'folders' && parts.length === 1) {
      if (req.method === 'POST') {
        const f = safeFolder(((await body(req)) as { path: string }).path ?? '');
        if (!f) return send(res, 400, { error: 'フォルダの名前がありません' });
        await mkdir(abs(f), { recursive: true });
        return send(res, 200, { ok: true, path: f });
      }
      if (req.method === 'PUT') {
        const { from, to } = (await body(req)) as { from: string; to: string };
        const a = safeFolder(from ?? '');
        const b = safeFolder(to ?? '');
        if (!a || !b) return send(res, 400, { error: 'フォルダの名前がありません' });
        if (`${b}/`.toLowerCase().startsWith(`${a}/`.toLowerCase()) && a.toLowerCase() !== b.toLowerCase()) return send(res, 400, { error: 'フォルダを自分の中には動かせません' });
        if (a !== b && (await walkDirs()).some((d) => d.toLowerCase() === b.toLowerCase()) && a.toLowerCase() !== b.toLowerCase())
          return send(res, 409, { error: `「${b}」はもうあります` });
        if (folderOf(b)) await mkdir(abs(folderOf(b)), { recursive: true });
        await rename(abs(a), abs(b));
        await scan();
        return send(res, 200, { ok: true, path: b });
      }
      if (req.method === 'DELETE') {
        const f = safeFolder(url.searchParams.get('path') ?? '');
        if (!f) return send(res, 400, { error: 'フォルダの名前がありません' });
        if (!(await removeIfEmpty(f))) return send(res, 409, { error: 'プロジェクトが入っているフォルダは消せません' });
        return send(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'index' && req.method === 'PUT') {
      const next = (await body(req)) as { order?: string[] } | null;
      const now = await readJson<{ order?: string[] }>(indexFile);
      // 一覧が空に（ほとんど空に）なるような書き換えは、何かがおかしいので書かない
      if (now?.order?.length && (!next?.order || next.order.length < now.order.length / 2))
        throw new StoreUnreadable(`一覧（index.json）を ${now.order.length} 件から ${next?.order?.length ?? 0} 件に減らす書き換えなので、書きませんでした`);
      await writeJson(indexFile, next);
      return send(res, 200, { ok: true });
    }

    const id = parts[0];
    if (!id || !ID.test(id)) return send(res, 400, { error: 'bad id' });

    // ファイルの版（updated）だけ。開いている画面が、別の機器で進んだかを見る（目印は書かない）
    if (req.method === 'GET' && parts[1] === 'updated') {
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(abs(file)));
      if (!p) return send(res, 404, { error: 'not found' });
      return send(res, 200, { updated: p.updated });
    }
    if (req.method === 'GET') {
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(abs(file)));
      if (!p) return send(res, 404, { error: 'not found' });
      const lock = await readJson<{ host: string; time: number }>(lockOf(id));
      await touchLock(id, req);
      return send(res, 200, { ...p, lock });
    }
    if (req.method === 'PUT' && parts[1] === 'rename') {
      const { name } = (await body(req)) as { name: string };
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(abs(file)));
      if (p) await put(id, { name, updated: p.updated, state: p.state });
      return send(res, 200, { ok: true, file: files.get(id) });
    }
    // フォルダを変える（ファイルを移す）
    if (req.method === 'PUT' && parts[1] === 'folder') {
      const { folder } = (await body(req)) as { folder: string };
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(abs(file)));
      if (!p) return send(res, 404, { error: 'not found' });
      await put(id, { name: p.name, updated: p.updated, state: p.state }, folder);
      return send(res, 200, { ok: true, file: files.get(id), folder: folderOf(files.get(id)!) });
    }
    if (req.method === 'PUT') {
      const { name, state, updated, folder, base } = (await body(req)) as { name: string; state: unknown; updated: number; folder?: string; base?: number };
      // base（その画面が最後に読んだ・書いた版）が今のファイルの版と違えば、別の機器（iPad など）が後から保存している。
      // 古い画面の状態で上書きすると、そちらで進めた分が消えるので書かない（2026-11-23）。base を送らない古い画面はそのまま書く
      if (base !== undefined) {
        const file = await fileOf(id);
        const now = file && (await readJson<ProjectFile>(abs(file)));
        if (now && typeof now.updated === 'number' && now.updated !== base) return send(res, 409, { error: 'conflict', updated: now.updated });
      }
      // base がある（画面が前にファイルを読んだ・書いた）か一覧に載っていれば、前からあるプロジェクト
      await put(id, { name, updated, state }, folder, base !== undefined || (await listed(id)));
      await touchLock(id, req);
      return send(res, 200, { ok: true, file: files.get(id) });
    }
    if (req.method === 'DELETE') {
      const file = await fileOf(id);
      if (file && (await holds(file, id))) {
        await backup(id, file, true);
        await unlink(abs(file)).catch(() => {});
      }
      await unlink(lockOf(id)).catch(() => {});
      files.delete(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // ---- 定型（/api/templates）----
  //   GET    /                         { templates: [{ name, updated, settings }], default }
  //   PUT    /         { name, settings } 保存（同じ名前は上書き）
  //   DELETE /?name=…                  消す
  //   PUT    /default  { name | null }  新しいプロジェクトに使う定型
  const templates = path.join(dir, 'templates');
  const tplSettings = path.join(templates, '_settings.json');
  const TPL = '.fxt.json';
  const tplFile = (name: string) => path.join(templates, `${safeFileName(name)}${TPL}`);

  async function handleTemplates(req: IncomingMessage, res: ServerResponse) {
    await assertStoreReadable(dir);
    await mkdir(templates, { recursive: true });
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'default' && req.method === 'PUT') {
      const { name } = (await body(req)) as { name: string | null };
      await writeJson(tplSettings, { default: name || null });
      return send(res, 200, { ok: true });
    }
    if (parts.length) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') {
      const list = [];
      for (const f of (await listDir(templates)).filter((x) => x.endsWith(TPL)).sort()) {
        const t = await readJson<{ name: string; updated: number; settings: unknown }>(path.join(templates, f));
        if (t?.name) list.push({ name: t.name, updated: t.updated, settings: t.settings });
      }
      const st = await readJson<{ default: string | null }>(tplSettings);
      return send(res, 200, { templates: list, default: st?.default ?? null });
    }
    if (req.method === 'PUT') {
      const { name, settings } = (await body(req)) as { name: string; settings: unknown };
      if (!name?.trim()) return send(res, 400, { error: '定型の名前がありません' });
      await writeJson(tplFile(name.trim()), { format: 'fx-practice-template', version: 1, name: name.trim(), updated: Date.now(), settings });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      const name = url.searchParams.get('name') ?? '';
      await unlink(tplFile(name)).catch(() => {});
      const st = await readJson<{ default: string | null }>(tplSettings);
      if (st?.default === name) await writeJson(tplSettings, { default: null });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // ---- 共通の設定（/api/settings）----
  //   GET  /           { keymap?, … }
  //   PUT  /  { … }    渡した項目だけ書き換える
  const appSettings = path.join(dir, 'settings.json');

  /**
   * キーの設定は以前はプロジェクトごとだった。共通の設定にまだ無ければ、キーを変えてあるプロジェクトのうち
   * 一番最近保存したものの設定を引き継ぐ（初めて開いたプロジェクトがキーを変えていないものでも、作り直さなくて済むように）
   */
  async function keymapFromProjects(): Promise<unknown> {
    let best: { updated: number; keymap: unknown } | null = null;
    for (const rel of await walk()) {
      const p = await readJson<ProjectFile>(abs(rel));
      const keymap = (p?.state as { keymap?: unknown } | undefined)?.keymap;
      if (keymap && p && (!best || p.updated > best.updated)) best = { updated: p.updated, keymap };
    }
    return best?.keymap;
  }

  // ---- チャートの画像（/api/screenshots）----
  //   POST /       { folder, files: [{ name, data（data:image/png;base64,…）}] }  保存して { dir } を返す
  //   POST /open   { folder }  そのフォルダを Finder で開く
  const shots = path.join(dir, 'screenshots');

  async function handleScreenshots(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    await assertStoreReadable(dir);
    const url = new URL(req.url ?? '/', 'http://x');
    const b = (await body(req)) as { folder?: string; files?: { name: string; data: string }[] };
    const folder = path.join(shots, safeFileName(b.folder || 'その他'));
    await mkdir(folder, { recursive: true });
    if (url.pathname.replace(/\/+$/, '') === '/open') {
      execFile('open', [folder]);
      return send(res, 200, { dir: folder });
    }
    for (const f of b.files ?? []) {
      const m = /^data:image\/png;base64,(.+)$/.exec(f.data);
      if (!m) continue;
      await writeFile(path.join(folder, `${safeFileName(f.name.replace(/\.png$/i, ''))}.png`), Buffer.from(m[1], 'base64'));
    }
    return send(res, 200, { dir: folder });
  }

  // ---- アラートの Mac の通知（/api/notify。2026-11-26）----
  //   POST / { title, body, key }  Mac の通知センターに出す。同じ key は 60 秒に 1 回だけ（2 つの画面で開いていても 1 回）
  const notified = new Map<string, number>();
  async function handleNotify(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const b = (await body(req)) as { title?: string; body?: string; key?: string };
    const now = Date.now();
    for (const [k, at] of notified) if (now - at > 60_000) notified.delete(k);
    if (b.key && notified.has(b.key)) return send(res, 200, { ok: true, skipped: true });
    if (b.key) notified.set(b.key, now);
    // 文字は引数で渡す（AppleScript の文の中に埋め込まない）
    execFile('osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      '-e',
      'end run',
      String(b.title ?? 'FX Practice').slice(0, 200),
      String(b.body ?? '').slice(0, 500),
    ]);
    return send(res, 200, { ok: true });
  }

  /** 共通の設定のファイルがもうあるはずか（一覧があれば、前に設定も書いている） */
  async function settingsShouldExist(): Promise<boolean> {
    return (await listDir(dir)).includes('index.json');
  }

  async function handleSettings(req: IncomingMessage, res: ServerResponse) {
    // 読めないときに {} を返したり、{} に書き足したりすると、共通の設定（キー・色・札など）が消える
    await assertStoreReadable(dir);
    if (req.method === 'GET') {
      const found = await readJson<Record<string, unknown>>(appSettings);
      if (!found && (await settingsShouldExist())) throw new StoreUnreadable('共通の設定（settings.json）が見つかりません（Dropbox が入れ替えている途中かもしれません）');
      const cur = found ?? {};
      if (!cur.keymap) {
        const keymap = await keymapFromProjects();
        if (keymap) {
          cur.keymap = keymap;
          await writeJson(appSettings, cur);
        }
      }
      return send(res, 200, cur);
    }
    if (req.method === 'PUT') {
      const patch = (await body(req)) as Record<string, unknown>;
      const cur = await readJson<Record<string, unknown>>(appSettings);
      // 設定のファイルが無いのは初めてのときだけ。前からあったのに無くなっていれば（Dropbox が入れ替えている途中など）書かない
      if (!cur && (await settingsShouldExist()))
        throw new StoreUnreadable('共通の設定（settings.json）が見つかりません。書き足すと設定が消えるので、書きませんでした');
      await writeJson(appSettings, { ...(cur ?? {}), ...patch });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return {
    name: 'fx-project-store',
    configureServer(server) {
      server.middlewares.use('/api/screenshots', (req, res) => {
        handleScreenshots(req, res).catch((e) => fail(res, e));
      });
      server.middlewares.use('/api/notify', (req, res) => {
        handleNotify(req, res).catch((e) => fail(res, e));
      });
      server.middlewares.use('/api/settings', (req, res) => {
        handleSettings(req, res).catch((e) => fail(res, e));
      });
      server.middlewares.use('/api/projects', (req, res) => {
        handle(req, res).catch((e) => fail(res, e));
      });
      server.middlewares.use('/api/templates', (req, res) => {
        handleTemplates(req, res).catch((e) => fail(res, e));
      });
    },
  };
}
