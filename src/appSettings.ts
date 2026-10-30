// 全部のプロジェクトで共通の設定（今はキーボードのショートカットだけ）。
// 保存先は開発サーバー（Dropbox の settings.json。server/projectStore.ts）なので、どの Mac でも同じ。
// 届かなければブラウザの中の控えを使う。

import type { NoteItem } from './ui/quickNotes';

export interface AppSettings {
  /** キーボードのショートカット（働き → キー。無ければ初期値。src/ui/keys.ts） */
  keymap?: Record<string, string[]>;
  /** スクショ（📷）で撮る時間足 */
  shotTfs?: string[];
  /** 簡易メモ（ツールバーの「📝 メモ」。階層つきの箇条書き） */
  quickNotes?: NoteItem[];
  /** 図形のマグネット（足の始値・高値・安値・終値に吸い付ける）を入れているか */
  magnet?: boolean;
  /** 図形の色を変えるときに右上の欄に並べる色 */
  palette?: string[];
  /** お気に入り（★）にしたプロジェクトの ID。左上の一覧の右側に並べる（付けた順） */
  favorites?: string[];
  /** 図形の太さ・線の種類の欄の場所（チャートの右端・上端からの距離。px） */
  styleBarPos?: { right: number; top: number };
  /** ライブの残り時間の場所（チャートの右端・上端からの距離。px）と文字の大きさ */
  countdown?: { right: number; top: number; size: number };
  /** 行のダブルクリックで指定した取引を、リスクリワードの形（建値・S/L・T/P）でも見せるか。無ければ見せる */
  tradeRR?: boolean;
}

const LOCAL_KEY = 'fx-practice-settings';

function readLocal(): AppSettings {
  try {
    return (JSON.parse(localStorage.getItem(LOCAL_KEY) ?? 'null') as AppSettings | null) ?? {};
  } catch {
    return {};
  }
}

function writeLocal(v: AppSettings) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
  } catch {
    // 入らなくても、サーバーに届いていれば困らない
  }
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(String(res.status));
    const v = (await res.json()) as AppSettings;
    writeLocal(v);
    return v;
  } catch {
    return readLocal();
  }
}

/** 渡した項目だけ書き換える */
export async function saveAppSettings(patch: AppSettings): Promise<void> {
  writeLocal({ ...readLocal(), ...patch });
  try {
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  } catch {
    // 次に保存したときに届けばよい（控えはブラウザに入っている）
  }
}
