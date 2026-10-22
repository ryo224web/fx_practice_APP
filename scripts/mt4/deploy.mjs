// scripts/mt4/ の自作の MT4 プログラム（R_*.mq4）を、Dropbox にある MT4 のデータフォルダへコピーする。
//
//   npm run deploy-mt4
//
// git では UTF-8 のまま持ち、コピー先には UTF-16（BOM 付き）・改行 CRLF で書く。
// MetaEditor は BOM の無い UTF-8 の日本語を読み違えることがあるが、UTF-16 なら正しく読む（MetaEditor 自身もこの形で保存する）。
// スクリプト（OnStart がある）は MQL4/Scripts、それ以外（EA）は MQL4/Experts へ。
// コピー先は環境変数 FXP_MT4_DIR で変えられる。コピーしたら MetaEditor でコンパイルし直すこと（Windows 機で）。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = path.resolve('scripts/mt4');
const DEST = process.env.FXP_MT4_DIR ?? '/Users/ryo/Library/CloudStorage/Dropbox/MT4/MQL4';

/** UTF-8 の文字列を、BOM 付き UTF-16LE・改行 CRLF のバイト列にする */
export function toMetaEditor(text) {
  const crlf = text.replace(/\r?\n/g, '\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf, 'utf16le')]);
}

async function main() {
  const files = (await readdir(SRC)).filter((f) => /^R_.*\.mq4$/.test(f));
  for (const f of files) {
    const text = await readFile(path.join(SRC, f), 'utf8');
    const kind = /\bvoid\s+OnStart\s*\(/.test(text) ? 'Scripts' : 'Experts';
    const dest = path.join(DEST, kind, f);
    await writeFile(dest, toMetaEditor(text));
    console.log(`${f} → ${dest}`);
  }
  console.log('Windows 機の MetaEditor でコンパイルし直してください（EA はチャートに付け直す）');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
