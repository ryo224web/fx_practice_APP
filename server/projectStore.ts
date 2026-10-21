// プロジェクトをフォルダにファイルで保存する（開発サーバーに組み込む）。
// ブラウザは外のフォルダに書けないので、アプリを動かしているサーバーが代わりに読み書きする。
//
//   <dir>/index.json                    今開いているプロジェクトと並び順（ID で持つ）
//   <dir>/projects/<名前>.fxp.json       プロジェクト 1 つ（「ファイルに書き出す」と同じ形式。中に ID も入れる）
//   <dir>/projects/.locks/<ID>.json     どの Mac が開いているか（別の Mac で同時に開かないための目印）
//
// ファイル名はプロジェクトの名前。名前を変えるとファイル名も変わる。同じ名前は「名前 (2)」のようにする。
// 保存先は環境変数 FXP_PROJECT_DIR で変えられる。

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
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

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
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

export function projectStore(dir = process.env.FXP_PROJECT_DIR || DEFAULT_PROJECT_DIR): Plugin {
  const projects = path.join(dir, 'projects');
  const locks = path.join(projects, '.locks');
  const indexFile = path.join(dir, 'index.json');
  const host = os.hostname();
  const lockOf = (id: string) => path.join(locks, `${id}.json`);
  const touchLock = (id: string) => writeJson(lockOf(id), { host, time: Date.now() });
  /** ID → ファイル名。毎回フォルダ中のファイルを読まないように覚えておく */
  const files = new Map<string, string>();

  /**
   * フォルダを読み直して ID とファイル名の対応を作る。
   * 以前の形式（ファイル名が ID）のファイルは、名前のファイル名に付け替える
   */
  async function scan(): Promise<{ id: string; name: string; updated: number }[]> {
    files.clear();
    const names = (await readdir(projects)).filter((f) => f.endsWith(EXT));
    const taken = new Set(names.map((f) => f.toLowerCase()));
    const list = [];
    for (const f of names) {
      const p = await readJson<ProjectFile>(path.join(projects, f));
      if (!p) continue;
      let file = f;
      let id = p.id;
      if (!id) {
        id = f.slice(0, -EXT.length);
        if (!ID.test(id)) continue;
        taken.delete(f.toLowerCase());
        file = uniqueFileName(p.name, taken);
        await writeJson(path.join(projects, file), { ...p, id });
        if (file !== f) await unlink(path.join(projects, f));
        // 以前の場所の目印も移す
        await rename(path.join(projects, `${id}.lock.json`), lockOf(id)).catch(() => {});
      }
      taken.add(file.toLowerCase());
      files.set(id, file);
      list.push({ id, name: p.name, updated: p.updated });
    }
    return list;
  }

  async function fileOf(id: string): Promise<string | null> {
    if (!files.has(id)) await scan();
    return files.get(id) ?? null;
  }

  /** プロジェクトを書く。名前が変わっていればファイル名も変える */
  async function put(id: string, value: Omit<ProjectFile, 'format' | 'version' | 'id'>) {
    const current = await fileOf(id);
    const wanted = safeFileName(value.name);
    let file = current;
    if (!current || current.normalize('NFC').toLowerCase().replace(/ \(\d+\)(?=\.fxp\.json$)/, '') !== `${wanted}${EXT}`.toLowerCase()) {
      const taken = new Set([...files.values()].filter((f) => f !== current).map((f) => f.toLowerCase()));
      file = uniqueFileName(value.name, taken);
    }
    await writeJson(path.join(projects, file!), { format: 'fx-practice-project', version: 1, id, ...value } satisfies ProjectFile);
    if (current && current !== file) await unlink(path.join(projects, current)).catch(() => {});
    files.set(id, file!);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    await mkdir(locks, { recursive: true });
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // 一覧
    if (parts.length === 0 && req.method === 'GET') {
      const list = await scan();
      return send(res, 200, { dir, host, index: await readJson(indexFile), projects: list });
    }

    if (parts[0] === 'index' && req.method === 'PUT') {
      await writeJson(indexFile, await body(req));
      return send(res, 200, { ok: true });
    }

    const id = parts[0];
    if (!id || !ID.test(id)) return send(res, 400, { error: 'bad id' });

    if (req.method === 'GET') {
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(path.join(projects, file)));
      if (!p) return send(res, 404, { error: 'not found' });
      const lock = await readJson<{ host: string; time: number }>(lockOf(id));
      await touchLock(id);
      return send(res, 200, { ...p, lock });
    }
    if (req.method === 'PUT' && parts[1] === 'rename') {
      const { name } = (await body(req)) as { name: string };
      const file = await fileOf(id);
      const p = file && (await readJson<ProjectFile>(path.join(projects, file)));
      if (p) await put(id, { name, updated: p.updated, state: p.state });
      return send(res, 200, { ok: true, file: files.get(id) });
    }
    if (req.method === 'PUT') {
      const { name, state, updated } = (await body(req)) as { name: string; state: unknown; updated: number };
      await put(id, { name, updated, state });
      await touchLock(id);
      return send(res, 200, { ok: true, file: files.get(id) });
    }
    if (req.method === 'DELETE') {
      const file = await fileOf(id);
      if (file) await unlink(path.join(projects, file)).catch(() => {});
      await unlink(lockOf(id)).catch(() => {});
      files.delete(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return {
    name: 'fx-project-store',
    configureServer(server) {
      server.middlewares.use('/api/projects', (req, res) => {
        handle(req, res).catch((e) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
      });
    },
  };
}
