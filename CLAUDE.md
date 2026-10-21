# FX Practice — 開発メモ

自分専用の FX 検証アプリ（Forex Tester 6 / Forex Tester Online の代わり）。Mac mini M4 上でローカルに動かす。クラウドは使わない。

## 作る理由（FT6 の不満）

- 最初の読み込みが遅く、検証のリズムが崩れる
- MT4 の取引履歴を読み込んで再現すると、ローソク足がずれて「何もない所で決済」される

## 満たすべき条件

- **R1: 開いて 1 秒以内に前回の続きから再開できる。** 表示までの時間は画面右上に出している。速度を落とす変更は必ず測ってから入れる
- **R2: MT4/MT5 の取引履歴を実データどおりに再現する。** 取引履歴の再現にはブローカー（TitanFX）自身の 1 分足を使い、約定は計算し直さず記録の価格・時刻のまま表示する。売りの決済・SL は Ask で約定するので Ask 線を表示する

## 決定事項

- 内部時刻はすべて UTC。表示と足の区切りのときだけ変換する（`src/core/time.ts`）
- TitanFX のサーバー時刻は「NY 時間 + 7 時間」（実測: 2026-10-21 サーバー 08:43 / 日本 14:43 → UTC+3）
  - 米国と欧州のどちらの夏時間に連動するかは未確定。2026-10-26〜30 に日本時間との差が 6 時間のままなら米国連動（現在の設定）、7 時間なら `eu-dst` に切り替える
- 上位足はすべて 1 分足からサーバー時刻で区切って作る（日足は NY 17:00 切り替え）
- 過去データは Dukascopy。Bid と Ask を両方持つ。形式は `scripts/lib/binfmt.mjs` に記載
  - 自動取得（`npm run fetch-data`）は 2026-10 時点で 429 で止められる。AWS S3（`cfg-public-proper-wallaby`）も 403 で使えなかった
  - そのため、サイトから手動でダウンロードした 1 分足の CSV（Bid・Ask、GMT）を外付け SSD の `/Volumes/Clucial_1TB/claude/dukascopy/` に置き、`npm run import-data` で変換する
  - Dukascopy の Ask の CSV は丸 1 日欠けることがある（出来高 0 で同じ値が並ぶ）。その足は Bid だけで保存し、Ask は null（作り出さない）
- 対象銘柄: USDJPY, EURUSD, GBPUSD, AUDUSD, USDCHF, USDCAD, NZDUSD, EURJPY, GBPJPY, XAUUSD
- MT4/MT5 は Windows 機（MSI または T580）にある。MT4 がメイン、口座は TitanFX

## 使っているマシン

Mac mini M4（メイン・開発と検証）/ MSI（Windows・MT4）/ T580（Windows・MT4）/ VMware ARM Windows（Mac mini 上）。
手順を書くときは、どのマシンで行うかを必ず明記する。

## 進め方

1. ~~Node.js~~
2. ~~TitanFX のサーバー時刻の確認~~
3. ~~アプリの土台~~
4. ~~Dukascopy のデータ取得~~（2026-10-20 の日足は MT4 と高値・安値が一致、始値・終値の差は 1 pips 未満）
5. リプレイ再生と仮想の注文（Ask 線・スプレッド表示。Ask が null の足では出さない） ← 次はここ。開始日の周辺だけ先に読み込む（20 年分を一度に読むと約 8 秒かかるため）
6. MT4 書き出しスクリプト（.mq4）+ 取引履歴の再現（時刻のずれを自動判定）
7. 取引記録の保存と成績統計（保存先は iCloud Drive などの同期フォルダを選べるようにする）
8. （任意）他の PC からの利用（Tailscale）
