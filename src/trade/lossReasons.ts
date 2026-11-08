// 取引に付ける「敗因」「勝因」の札と、それぞれの集計（成績タブの「敗因別」「勝因別」）。
// 負けた取引には敗因の一覧、勝った取引には勝因の一覧から付ける（ID は敗因 r1…、勝因 w1…）。
// 敗因の一覧と、どの取引にどの札を付けたかは全部のプロジェクトで共通の設定に入れる（MT4 の取引は月ごとのプロジェクトをまたぐため）。

import type { TradeRecord } from './analysis';

export interface LossReason {
  id: string;
  name: string;
}

/** 初めて使うときの一覧（それまで簡易メモに書いていた敗因） */
export const DEFAULT_LOSS_REASONS: LossReason[] = [
  { id: 'r1', name: 'エントリーが下降ダウ入りで入ってない' },
  { id: 'r2', name: 'H1 の波が戻ってない（波の戻りを待つ）' },
  { id: 'r3', name: 'SL 狩り後に狙い通りに進む' },
  { id: 'r4', name: '3 波ではなく 5 波になっていた（H1）' },
];

/** 初めて使うときの勝因の一覧（空。付けながら足していく） */
export const DEFAULT_WIN_REASONS: LossReason[] = [];

/** 勝ちの取引か（損益が 0 より大きい）。勝ちなら勝因、それ以外は敗因を付ける */
export const isWin = (profit: number) => profit > 0;

export interface ReasonRow {
  reason: LossReason;
  count: number;
  /** 札を付けた取引の損益の合計（円） */
  profit: number;
  pips: number;
  trades: TradeRecord[];
}

export interface ReasonTally {
  rows: ReasonRow[];
  /** 札の無い取引（負けを数えるなら負け、勝ちなら勝ち。付け忘れを見つけるため。新しい順） */
  untagged: TradeRecord[];
}

/**
 * 敗因ごとに回数・損益を数える。1 つの取引に札が 2 つあれば、両方に数える。
 * 一覧から消した敗因の札は数えない。並びは一覧の並び（札を付ける欄・成績タブの表のドラッグで変える）
 */
export function tallyReasons(records: TradeRecord[], reasons: LossReason[], tagsOf: (r: TradeRecord) => string[], wins = false): ReasonTally {
  const rows = new Map(reasons.map((reason) => [reason.id, { reason, count: 0, profit: 0, pips: 0, trades: [] as TradeRecord[] }]));
  const untagged: TradeRecord[] = [];
  for (const r of records) {
    const tags = tagsOf(r).filter((id) => rows.has(id));
    for (const id of new Set(tags)) {
      const row = rows.get(id)!;
      row.count++;
      row.profit += r.profit;
      row.pips += r.pips;
      row.trades.push(r);
    }
    if (!tags.length && isWin(r.profit) === wins) untagged.push(r);
  }
  untagged.sort((a, b) => b.closeTime - a.closeTime);
  return {
    rows: [...rows.values()].filter((x) => x.count),
    untagged,
  };
}

/** 新しい敗因の ID（今ある ID と重ならないもの） */
export function newReasonId(reasons: LossReason[], prefix = 'r'): string {
  let n = reasons.length + 1;
  while (reasons.some((r) => r.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** フィボの数値の札か（「38.2」「61.8-78.6」のように数と区切りだけの名前） */
export const isFiboReason = (name: string) => /^\s*\d+(\.\d+)?(\s*[-–〜~]\s*\d+(\.\d+)?)?\s*$/.test(name);

/**
 * もう一方の一覧にあって、この一覧に無い札の名前（勝因と同じ項目（フィボの数値・エントリーの形など）を敗因にも用意して、
 * 組み合わせごとに勝ち負けを比べるため）。名前の空白の違いは同じとみなす。並びはもう一方の一覧のまま
 */
export function missingReasons(list: LossReason[], other: LossReason[]): string[] {
  const norm = (n: string) => n.replace(/\s/g, '');
  const have = new Set(list.map((r) => norm(r.name)));
  return other.filter((r) => !have.has(norm(r.name))).map((r) => r.name);
}

export interface NameRow {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  /** R の合計と、R を出せた回数 */
  r: number;
  rTrades: number;
  tickets: TradeRecord[];
}

/** 区切りのための札（「-----」だけの名前）。数えない */
export const isSeparatorReason = (name: string) => /^[\s\-–—ー_=]*$/.test(name);

/**
 * 勝因・敗因を同じ名前（空白の違いは同じとみなす）でまとめて、その札が付いた取引の勝ち負けと R を数える。
 * 勝因と敗因に同じ項目（フィボの数値・エントリーの形・H4 の向きなど）を用意して付けているので、
 * 名前ごとに「付いた取引は何勝何敗、何 R か」を見れば、その条件が効いているかが分かる。
 * 円ではなく R で見るのは、複利で後半の取引ほど金額が大きくなり、後半に多い札ほど大きく出てしまうため。
 * 並びは勝因の一覧の順、そのあとに敗因だけにある名前。区切りの札は数えない
 */
export function tallyByName(
  records: TradeRecord[],
  lossList: LossReason[],
  winList: LossReason[],
  tagsOf: (r: TradeRecord) => string[],
  rOf: (r: TradeRecord) => number | null,
): NameRow[] {
  const norm = (n: string) => n.replace(/\s/g, '');
  const nameOf = new Map<string, string>();
  const rows = new Map<string, NameRow>();
  for (const x of [...winList, ...lossList]) {
    if (isSeparatorReason(x.name)) continue;
    const k = norm(x.name);
    nameOf.set(x.id, k);
    if (!rows.has(k)) rows.set(k, { name: x.name, trades: 0, wins: 0, losses: 0, r: 0, rTrades: 0, tickets: [] });
  }
  for (const rec of records) {
    for (const k of new Set(tagsOf(rec).map((id) => nameOf.get(id)).filter((k): k is string => !!k))) {
      const row = rows.get(k)!;
      row.trades++;
      if (isWin(rec.profit)) row.wins++;
      else row.losses++;
      const r = rOf(rec);
      if (r !== null) {
        row.r += r;
        row.rTrades++;
      }
      row.tickets.push(rec);
    }
  }
  return [...rows.values()].filter((x) => x.trades);
}
