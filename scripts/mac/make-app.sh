#!/bin/zsh
# FX Practice の専用アプリを ~/Applications に作る（Mac mini。プロジェクトのフォルダを移したら、もう一度実行する）
#   npm run make-app
# - FX Practice.app: 開くとサーバーを起動して、自分のウィンドウに FP を出す（閉じるとサーバーも止める）。中身は scripts/mac/app/FXPractice.swift
# - FX Practice を終了.app: ブラウザで使っていたときなどに、裏で動いているサーバーを止める（scripts/mac/stop.sh）
# できたアプリは Dock にドラッグしておくと便利。ブラウザで使うときは scripts/mac/launch.sh（Chrome のアプリのウィンドウで開く）
# Swift（Xcode の Command Line Tools）が要る。無ければ xcode-select --install
# 動作確認用: FXP_APP_DEST（作る場所）・FXP_PORT（番号）・FXP_VITE_ARGS（vite に足す引数。--config など）

set -e
here="${0:A:h}"
root="${here:h:h}"
dest="${FXP_APP_DEST:-$HOME/Applications}"
app="$dest/FX Practice.app"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$dest"
chmod +x "$here/launch.sh" "$here/stop.sh"

if ! command -v swiftc >/dev/null; then
  echo "Swift がありません。xcode-select --install で Command Line Tools を入れてから、もう一度実行してください"
  exit 1
fi

echo "アプリを作っています…"
swiftc -O -o "$work/FX Practice" "$here/app/FXPractice.swift" -framework AppKit -framework WebKit

# アイコン（1024px の絵を描いて、大きさごとの .icns にする）
swift "$here/app/icon.swift" "$work/icon.png"
mkdir "$work/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$work/icon.png" --out "$work/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$work/icon.png" --out "$work/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns -o "$work/icon.icns" "$work/icon.iconset"

# 以前の AppleScript のアプリと入れ替える
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
mv "$work/FX Practice" "$app/Contents/MacOS/FX Practice"
mv "$work/icon.icns" "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>FX Practice</string>
  <key>CFBundleDisplayName</key><string>FX Practice</string>
  <key>CFBundleIdentifier</key><string>local.fx-practice</string>
  <key>CFBundleExecutable</key><string>FX Practice</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>R（FX Practice 用の自作ツール）</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>FXPProjectDir</key><string>$root</string>
  <key>FXPPort</key><string>${FXP_PORT:-5173}</string>
  <key>FXPViteArgs</key><string>${FXP_VITE_ARGS:-}</string>
</dict>
</plist>
PLIST
# Apple シリコンでは署名が要る（この Mac だけで使うので、名前の無い署名でよい）
codesign --force --sign - "$app" >/dev/null 2>&1

osacompile -o "$dest/FX Practice を終了.app" -e "do shell script quoted form of \"$here/stop.sh\"" -e 'display notification "FX Practice を終了しました"'
# Finder や Dock のアイコンを描き直させる
touch "$app"
echo "作りました: $app と FX Practice を終了.app"
