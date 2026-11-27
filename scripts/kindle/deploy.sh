#!/bin/zsh
# Kindle（USB でつないだもの）の documents に FX ダッシュボードのスクリプトを入れる。Mac mini で npm run deploy-kindle
set -e
here=${0:a:h}
kindle=""
for v in /Volumes/*; do
  if [[ -f "$v/system/version.txt" ]] && grep -q '^Kindle' "$v/system/version.txt"; then kindle=$v; break; fi
done
if [[ -z $kindle ]]; then echo "Kindle が見つかりません（USB でつないでください）"; exit 1; fi
# Kindle は改行が LF でないと動かないので、そのまま写す（Mac の隠しファイル ._ は作らない）
COPYFILE_DISABLE=1 cp -X "$here/fxp_dash.sh" "$kindle/documents/fxp_dash.sh"
rm -f "$kindle/documents/._fxp_dash.sh"
echo "入れました: $kindle/documents/fxp_dash.sh"
diskutil eject "$kindle" && echo "取り出しました"
