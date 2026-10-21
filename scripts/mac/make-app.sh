#!/bin/zsh
# ダブルクリックで起動・終了できるアプリを ~/Applications に作る（Mac mini で 1 回だけ実行）
#   npm run make-app
# できたアプリは Dock にドラッグしておくと便利。プロジェクトのフォルダを移したら作り直す。

set -e
here="${0:A:h}"
dest="$HOME/Applications"
mkdir -p "$dest"
chmod +x "$here/launch.sh" "$here/stop.sh"
osacompile -o "$dest/FX Practice.app" -e "do shell script quoted form of \"$here/launch.sh\""
osacompile -o "$dest/FX Practice を終了.app" -e "do shell script quoted form of \"$here/stop.sh\"" -e 'display notification "FX Practice を終了しました"'
echo "作りました: $dest/FX Practice.app と FX Practice を終了.app"
