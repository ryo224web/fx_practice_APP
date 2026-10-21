// プロジェクトをフォルダにファイルで保存する（開発サーバーに組み込む）。
// ブラウザは外のフォルダに書けないので、アプリを動かしているサーバーが代わりに読み書きする。
//
//   <dir>/index.json              今開いているプロジェクトと並び順
//   <dir>/projects/<id>.fxp.json  プロジェクト 1 つ（「ファイルに書き出す」と同じ形式）
//   <dir>/projects/<id>.lock.json どの Mac が開いているか（別の Mac で同時に開かないための目印）
//
// 保存先は環境変数 FXP_PROJECT_DIR で変えられる。

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';

export const DEFAULT_PROJECT_DIR = '/Users/ryo/Library/CloudStorage/Dropbox/Claude/fx_practice';

const ID = /^[A-Za-z0-9-]{1,64}$/;

interface ProjectFile {
  format: 'fx-practice-project';
  version: 1;
  name: string;
  updated: number;
  state: unknown;
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
  const tmp = `${file}.${process.pid}.tmp`;
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
  const indexFile = path.join(dir, 'index.json');
  const host = os.hostname();
  const fileOf = (id: string) => path.join(projects, `${id}.fxp.json`);
  const lockOf = (id: string) => path.join(projects, `${id}.lock.json`);
  const touchLock = (id: string) => writeJson(lockOf(id), { host, time: Date.now() });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    await mkdir(projects, { recursive: true });
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // 一覧
    if (parts.length === 0 && req.method === 'GET') {
      const list = [];
      for (const f of await readdir(projects)) {
        const m = /^(.+)\.fxp\.json$/.exec(f);
        if (!m) continue;
        const p = await readJson<ProjectFile>(path.join(projects, f));
        if (p) list.push({ id: m[1], name: p.name, updated: p.updated });
      }
      return send(res, 200, { dir, host, index: await readJson(indexFile), projects: list });
    }

    if (parts[0] === 'index' && req.method === 'PUT') {
      await writeJson(indexFile, await body(req));
      return send(res, 200, { ok: true });
    }

    const id = parts[0];
    if (!id || !ID.test(id)) return send(res, 400, { error: 'bad id' });

    if (req.method === 'GET') {
      const p = await readJson<ProjectFile>(fileOf(id));
      if (!p) return send(res, 404, { error: 'not found' });
      const lock = await readJson<{ host: string; time: number }>(lockOf(id));
      await touchLock(id);
      return send(res, 200, { ...p, lock });
    }
    if (req.method === 'PUT' && parts[1] === 'rename') {
      const p = await readJson<ProjectFile>(fileOf(id));
      const { name } = (await body(req)) as { name: string };
      if (p) await writeJson(fileOf(id), { ...p, name });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      const { name, state, updated } = (await body(req)) as { name: string; state: unknown; updated: number };
      const file: ProjectFile = { format: 'fx-practice-project', version: 1, name, updated, state };
      await writeJson(fileOf(id), file);
      await touchLock(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await unlink(fileOf(id)).catch(() => {});
      await unlink(lockOf(id)).catch(() => {});
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
