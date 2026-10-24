// 定型（MT4 の定型チャートと同じ考え）。チャートの並べ方・時間足・インジケーター・図形の色などに名前を付けて保存し、
// どのプロジェクトにも当てられる。新しいプロジェクトに使う定型も決めておける。
// 保存先は開発サーバー（Dropbox の templates/。server/projectStore.ts）。届かなければブラウザの中だけ。

import type { AppState } from './state';

/** 定型に入れる設定（検証・図形・MT4 履歴・キーボードは入れない） */
export const TEMPLATE_KEYS = ['layout', 'panes', 'indicatorSets', 'tfColors', 'lineWidths', 'fiboLevels', 'hiddenTfs', 'rightOffset', 'zone', 'hideOneClick'] as const;
export type TemplateSettings = Partial<Pick<AppState, (typeof TEMPLATE_KEYS)[number]>>;

export interface ChartTemplate {
  name: string;
  updated: number;
  settings: TemplateSettings;
}

const LOCAL_KEY = 'fx-practice-templates';

/** 今の設定から定型に入れる分を取り出す */
export function pickTemplate(state: AppState): TemplateSettings {
  const out: Record<string, unknown> = {};
  for (const k of TEMPLATE_KEYS) if (state[k] !== undefined) out[k] = structuredClone(state[k]);
  return out as TemplateSettings;
}

/** 定型を当てた設定（検証・図形などはそのまま） */
export function applyTemplate(state: AppState, settings: TemplateSettings): AppState {
  const next = { ...state };
  for (const k of TEMPLATE_KEYS) {
    if (settings[k] !== undefined) (next as Record<string, unknown>)[k] = structuredClone(settings[k]);
    else delete (next as Record<string, unknown>)[k];
  }
  return next;
}

interface LocalTemplates {
  templates: ChartTemplate[];
  default: string | null;
}

function readLocal(): LocalTemplates {
  try {
    return (JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null') as LocalTemplates | null) ?? { templates: [], default: null };
  } catch {
    return { templates: [], default: null };
  }
}

function writeLocal(v: LocalTemplates) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
  } catch {
    // 入らなくても、サーバーに届いていれば困らない
  }
}

let remote = true;

async function api(method: string, path = '', value?: unknown): Promise<Response> {
  const res = await fetch(`/api/templates${path}`, {
    method,
    headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`定型の保存先との通信に失敗しました（${res.status}）`);
  return res;
}

/** 定型の一覧と、新しいプロジェクトに使う定型の名前 */
export async function loadTemplates(): Promise<LocalTemplates> {
  try {
    const v = (await (await api('GET')).json()) as LocalTemplates;
    remote = true;
    writeLocal(v);
    return v;
  } catch {
    remote = false;
    return readLocal();
  }
}

export async function saveTemplate(name: string, settings: TemplateSettings): Promise<void> {
  const local = readLocal();
  local.templates = [...local.templates.filter((t) => t.name !== name), { name, updated: Date.now(), settings }].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  writeLocal(local);
  if (remote) await api('PUT', '', { name, settings });
}

export async function deleteTemplate(name: string): Promise<void> {
  const local = readLocal();
  local.templates = local.templates.filter((t) => t.name !== name);
  if (local.default === name) local.default = null;
  writeLocal(local);
  if (remote) await api('DELETE', `?name=${encodeURIComponent(name)}`);
}

export async function setDefaultTemplate(name: string | null): Promise<void> {
  const local = readLocal();
  local.default = name;
  writeLocal(local);
  if (remote) await api('PUT', '/default', { name });
}
