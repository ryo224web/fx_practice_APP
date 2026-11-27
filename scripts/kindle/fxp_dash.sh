#!/bin/sh
# Name: FX ダッシュボード
# Author: fx_practice
# DontUseFBInk
#
# 脱獄した Kindle Paperwhite 2 で、Mac mini の Kindle 用のサーバー（server/kindleServer.ts）が作る画像（指標・天気）を 5 分ごとに取ってきて全画面に出す。
# 本の一覧のこのファイルをタップすると始まる。
#   5 分ごとに起きる → Wi-Fi がつながるのを待つ → 電池の残量を伝えて画像を取る → 画面を書き換える → すぐ眠る（電池を持たせるため）
#   書き換えはふだん点滅なし。毎時 0〜4 分の回だけ点滅ありで全体を描き直して残像を消す
#   Mac mini が寝ていて取れないときは、前の画面の上端に「Mac mini お休み中」の帯を 1 回だけ重ね、5 分ごとに試し続ける
#   （Mac が答えなければ 5 秒で諦めるので、電池の減りはふだんと同じ。Mac が起きたら 5 分以内に戻る）
#   充電は USB の充電器で（ダッシュボードのまま充電できる）。Mac につなぐとドライブモードになるので、その間は何もせずに待ち、
#   Mac から取り出したら止まっていつもの Kindle に戻る
#   ケーブルを挿したままなら、電池 80% で充電を止め、40% で再開する（ダッシュボードを止めると充電は許可に戻す）
#   止めるとき: 電源ボタンを 1 回押す（電源ボタンの入力を見張っている。ケーブルの抜き挿しでも同じ入力が来るので、それは無視して続ける。
#   充電中などで眠れないときは画面のタップでも止まる）
#   戻らなくなったら: 電源ボタンを 20 秒ほど押し続けると再起動する（ふつうの Kindle に戻る）
# 置き場所: Kindle の documents フォルダ（Mac mini で npm run deploy-kindle）。記録は Kindle の一番上の fxp_dash.log。

# Mac mini の Wi-Fi のアドレスと、Kindle の向き（270: Kindle の下側（USB の口）を左にして横に置く / 90: 右に置く）
BASE="http://192.168.40.227:8090"
URL="$BASE/kindle.png"
ROT=270
EVERY=300
# ケーブルを挿したままのとき、電池がこの % 以上で充電を止め、この % 以下で再開する（満充電のまま置くと電池が傷むため）
CHG_STOP=80
CHG_START=40
# 1: 更新の間は眠る（電池が持つ。眠る間は機内モードで Wi-Fi を切る）/ 0: 起きたまま待つ（画面をタップしても止まる）
SLEEP=1

# 脱獄（WinterBreak2）が入れた fbink（画像を画面に出す道具）
export PATH="/mnt/us/libkh/bin:$PATH"

LOG=/mnt/us/fxp_dash.log
PID=/tmp/fxp_dash.pid
IMG=/tmp/fxp_dash.png
# 最後に出した画面の控え（起動したとき、取れるまでの間にすぐ出す。真っ白で待たせないため。2026-11-27）
LAST=/mnt/us/.fxp_last_$ROT.png
# 「Mac mini お休み中」の帯（Mac が起きている間に 1 回取って持っておく。消えないよう Kindle の保存領域に）
OFF=/mnt/us/.fxp_off_v2_$ROT.png
AWAKE=/tmp/fxp_dash.awake
# 眠っている間・起きた直後に届いた電源ボタンの入力の時刻
KEYF=/tmp/fxp_dash.key
# ケーブルが挿さっているか（最後に見た値）。ケーブルを抜き挿しすると、電源ボタンと同じ入力が届くため（2026-11-27）
USBF=/tmp/fxp_dash.usb
# ケーブルの抜き挿し・充電の切り替えをした時刻。その後 30 秒は電源ボタンと同じ入力を無視する（充電の状態が変わるたびにも届くため。2026-11-27）
CHGF=/tmp/fxp_dash.chg

# ドライブモード（Mac につないで保存領域を Mac に渡している間）か。その間は /mnt/us の中身が見えない
in_drive() { [ ! -d /mnt/us/documents ]; }

log() {
  # ドライブモードの間は保存領域に書けないので /tmp に残す
  if in_drive; then echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> /tmp/fxp_dash.log; return; fi
  # 記録が 300 KB を超えたら後ろ半分だけ残す
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 300000 ]; then tail -c 150000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# 充電を許可するか（PW2 の充電の設定。0 にするとケーブルを挿したままでも充電が止まり、電池で動く。2026-11-27 に確かめた。
# 再起動すると 1 に戻る）
ALLOW=/sys/devices/system/wario_charger/wario_charger0/allow_charging
charge_control() {
  [ -w "$ALLOW" ] && [ -n "$1" ] || return
  b=$1
  a=$(cat "$ALLOW" 2>/dev/null)
  # ケーブルを抜いたら許可に戻す（止めたまま抜くと、次に 60% などで挿したとき 40% まで充電されなかった。2026-11-27）
  case "$(usb_state)" in
    *1*) ;;
    *) [ "$a" = 0 ] && echo 1 > "$ALLOW" && log "charging allowed again (unplugged)"; return ;;
  esac
  if [ "$a" = 1 ] && [ "$b" -ge "$CHG_STOP" ]; then
    echo 0 > "$ALLOW" && log "charging off at ${b}%" && date +%s > "$CHGF"
  elif [ "$a" = 0 ] && [ "$b" -le "$CHG_START" ]; then
    echo 1 > "$ALLOW" && log "charging on at ${b}%" && date +%s > "$CHGF"
  fi
}
# 充電をお休みしているか（1: 止めている）
charge_held() { [ "$(cat "$ALLOW" 2>/dev/null)" = 0 ] && echo 1 || echo 0; }

battery() { lipc-get-prop com.lab126.powerd battLevel 2>/dev/null || gasgauge-info -s 2>/dev/null | tr -dc '0-9'; }
charging() { [ "$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null)" = 1 ] && echo 1 || echo 0; }

# 2 つ目が 1 なら点滅ありの描き直し（残像を消す）
# 書き換えが終わるまで待ってから戻る（すぐ眠ると、書き換えの途中で止まって薄くなった。2026-11-27）
show() {
  if command -v fbink >/dev/null 2>&1; then
    if [ "$2" = 1 ]; then f="-c -f"; else f=""; fi
    # -w: 書き換えが終わるまで待つ（古い fbink に無ければ付けずに出す）
    fbink -q -w $f -g file="$1" 2>/dev/null || fbink -q $f -g file="$1"
  else
    if [ "$2" = 1 ]; then eips -f -g "$1" >/dev/null; else eips -g "$1" >/dev/null; fi
  fi
  sleep 2
}

# Wi-Fi がつながるのを 45 秒まで待つ（眠りから覚めた直後はつながっていない）。
# 機内モードを切って待つ。20 秒たってもつながらなければ機内モードを入れて切り直す
# （2026-11-27 に、起きたあと Wi-Fi が「NA」のまま 2 回続けてつながらず、「お休み中」の帯が出た）
wifi_state() { echo "cm=$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null) wireless=$(lipc-get-prop com.lab126.cmd wirelessEnable 2>/dev/null)"; }
wifi_ready() {
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  i=0
  while [ $i -lt 45 ]; do
    [ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" = CONNECTED ] && return 0
    if [ $i = 20 ]; then
      log "wifi not connected after 20s ($(wifi_state)); turning wireless off and on"
      lipc-set-prop com.lab126.cmd wirelessEnable 0 2>/dev/null
      sleep 3
      lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# 名前（小文字にして正規表現）で入力の機器を探す（/proc/bus/input/devices の H: の行の event 番号）
# PW2 では電源ボタンが max77696-onkey、タッチが cyttsp4_mt（2026-11-27 の記録）
input_dev() {
  awk -v pat="$1" '/^N:/{n=tolower($0)} /^H:/{ if (n ~ pat && match($0, /event[0-9]+/)) { print "/dev/input/" substr($0, RSTART, RLENGTH); exit } }' /proc/bus/input/devices
}

# ケーブルの抜き挿し・充電の切り替えから 30 秒以内か
recent_power_change() { c=$(cat "$CHGF" 2>/dev/null); [ -n "$c" ] && [ $(($(date +%s) - c)) -lt 30 ]; }

# ケーブルが挿さっているか（電源の管理チップの充電の口。"11" などの文字で比べるだけ）
usb_state() { cat /sys/class/power_supply/max77696-charger/present /sys/class/power_supply/max77696-uic/present 2>/dev/null | tr -d '\n'; }

# 時計で起こす（RTC）。rtc1 があればそれ、無ければ rtc0
RTC=/sys/class/rtc/rtc1
[ -e "$RTC/wakealarm" ] || RTC=/sys/class/rtc/rtc0

# ドライブモードに入っていたら、終わる（Mac から取り出す）まで何もせずに待ち、終わったら止めていつもの Kindle に戻す。
# ドライブモードの最中に止めて Kindle の画面を起動し直すと、ドライブモードをやり直してアプリケーションエラーになった（2026-11-27）
drive_check() {
  in_drive || return 0
  log "drive mode; waiting"
  while in_drive; do sleep 5; done
  [ -f /tmp/fxp_dash.log ] && cat /tmp/fxp_dash.log >> "$LOG" && rm -f /tmp/fxp_dash.log
  log "drive mode ended"
  stop_dash
}

# secs 秒たつまで眠る。眠る前に Wi-Fi を切る（Wi-Fi があると 15〜19 秒で起こされた。電池も減る。2026-11-27）
# 予定より早く起きたら、電源ボタンの入力があれば止める。無ければ（ほかの理由で起きた）残りをまた眠る。
# 眠れない（充電中など）ときは、その回は起きたまま待つ
nap() {
  target=$(($(date +%s) + $1))
  tries=0
  while :; do
    left=$((target - $(date +%s)))
    [ $left -lt 15 ] && break
    if [ "$SLEEP" = 1 ] && [ -e "$RTC/wakealarm" ] && [ $tries -lt 20 ]; then
      # Wi-Fi は機内モードで切る（設定画面と同じ操作）。Wi-Fi の部品を直接止める（wifid enable 0）のを 2 時間半ほど繰り返したら、
      # 部品が戻らなくなり、再起動するまでネットワークを見つけられなくなった（2026-11-27）
      lipc-set-prop com.lab126.cmd wirelessEnable 0 2>/dev/null
      echo 0 > "$AWAKE"
      rm -f "$KEYF"
      sleep 1
      echo 0 > "$RTC/wakealarm" 2>/dev/null
      if echo "+$left" > "$RTC/wakealarm" 2>/dev/null && echo mem > /sys/power/state 2>/dev/null; then
        tries=$((tries + 1))
        # 起きたときに届く電源ボタンの入力を待つ（見張りがケーブルの抜き挿しかを 1 秒見てから残す）
        sleep 3
        late=$((target - $(date +%s)))
        if [ $late -gt 15 ]; then
          # 予定より早く起きて電源ボタンの入力があれば、押して起こされた（ケーブルの抜き挿しで起きたときは見張りが残さない）
          drive_check
          if [ -f "$KEYF" ] && ! recent_power_change; then log "power button (woke ${late}s early)"; stop_dash; fi
          log "woke early: ${late}s left (usb=$(usb_state))"
        fi
        # 予定どおり時計で起きたときも電源ボタンの入力が 1 回届く（2026-11-27 にこれで止まった）ので、それは無視する
        rm -f "$KEYF"
        drive_check
        continue
      fi
      log "cannot suspend (charging=$(charging)); awake for ${left}s"
    fi
    # 起きたまま待つ（5 秒ごとにドライブモードに入っていないか見る）
    echo 1 > "$AWAKE"
    while [ $((target - $(date +%s))) -gt 0 ]; do
      drive_check
      sleep 5 &
      wait $!
    done
    break
  done
  echo 1 > "$AWAKE"
}

stop_dash() {
  log "stop"
  [ -n "$TOUCH_PID" ] && kill "$TOUCH_PID" 2>/dev/null
  [ -n "$KEY_PID" ] && kill "$KEY_PID" 2>/dev/null
  echo 0 > "$RTC/wakealarm" 2>/dev/null
  # ふつうの Kindle に戻すので、充電は許可に戻す
  [ -w "$ALLOW" ] && echo 1 > "$ALLOW"
  lipc-set-prop com.lab126.powerd preventScreenSaver 0
  # ふつうの Kindle に戻すので Wi-Fi はつけておく
  lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  rm -f "$PID" "$AWAKE" "$KEYF" "$USBF" "$CHGF"
  start lab126_gui 2>/dev/null || start framework 2>/dev/null
  exit 0
}

main() {
  echo $$ > "$PID"
  echo 1 > "$AWAKE"
  rm -f "$KEYF"
  log "start $URL rot=$ROT sleep=$SLEEP rtc=$RTC batt=$(battery) chg=$(charging)"
  # スリープ画面にしない・Kindle の画面（本の一覧など）を止めて上書きされないようにする
  lipc-set-prop com.lab126.powerd preventScreenSaver 1
  stop lab126_gui 2>/dev/null || stop framework 2>/dev/null
  sleep 2
  eips -c >/dev/null
  # 前回の画面があれば、まずそれを出す
  [ -s "$LAST" ] && cp "$LAST" "$IMG" && show "$IMG" 1
  trap stop_dash TERM INT

  # 電源ボタンを押したら止める（眠っているときに押すと、起きたあとでその入力が届く）
  KEY=$(input_dev onkey)
  # 起きたまま待っているとき（充電中で眠れないときなど）は、画面をタップしても止める
  TOUCH=$(input_dev 'touch|zforce|cyttsp|elan')
  log "input devices: $(grep '^N:' /proc/bus/input/devices 2>/dev/null | tr '\n' ' ') key=${KEY:-none} touch=${TOUCH:-none}"
  if [ -n "$KEY" ]; then
    # 起きているとき（AWAKE=1）に押されたらすぐ止める。眠っている間・起きた直後は時刻を残すだけ（nap が決める）
    # ケーブルを抜き挿ししたときも同じ入力が届くので、1 秒待ってケーブルの状態が変わっていれば、それは無視する
    usb_state > "$USBF"
    # 入力の中身（16 バイト。種類・ボタンの番号・押した/離した）も記録に残す（本物の電源ボタンと見分ける手がかりにする）
    ( while ev=$(dd if="$KEY" bs=16 count=1 2>/dev/null | od -An -tx1 | tr -s ' \n' ' '); [ -n "$ev" ]; do
        log "key event:$ev"
        sleep 1
        u=$(usb_state)
        if [ "$u" != "$(cat "$USBF" 2>/dev/null)" ]; then echo "$u" > "$USBF"; date +%s > "$CHGF"; log "cable changed (usb=$u)"; continue; fi
        # ケーブルの抜き挿し・充電の切り替えの直後に来る入力は無視する
        recent_power_change && { log "ignored (power change)"; continue; }
        # ドライブモードの切り替えの途中にも同じ入力が来るので、その間は無視する（終わったら drive_check が止める）
        in_drive && continue
        if [ "$(cat "$AWAKE" 2>/dev/null)" = 1 ]; then log "power button"; kill -TERM "$(cat "$PID")"; break; fi
        date +%s > "$KEYF"
      done ) &
    KEY_PID=$!
  fi
  if [ -n "$TOUCH" ]; then
    ( while head -c 1 "$TOUCH" >/dev/null 2>&1; do
        [ "$(cat "$AWAKE" 2>/dev/null)" = 1 ] && { log "tap"; kill -TERM "$(cat "$PID")"; break; }
        sleep 1
      done ) &
    TOUCH_PID=$!
  fi

  first=1; offline=0; fails=0
  while :; do
    drive_check
    B=$(battery)
    charge_control "$B"
    C=$(charging); H=$(charge_held)
    # ケーブルが挿さっているか（充電を止めている間も 1。画面の電池の横の絵を充電中のものにする）
    case "$(usb_state)" in *1*) P=1 ;; *) P=0 ;; esac
    # Mac mini が寝ているときは答えが無いので、つながらなければ 5 秒で諦める
    # 取れなかったら 15 秒待ってもう一度だけ試す（眠りから覚めた直後の Wi-Fi は、たまに遅れて 1 回失敗する。2026-11-27）
    got=0
    for try in 1 2; do
      if wifi_ready && curl -s -f --connect-timeout 5 --max-time 40 -o "$IMG.new" "$URL?rot=$ROT&batt=$B&chg=$C&hold=$H&plug=$P"; then got=1; break; fi
      [ $try = 1 ] && { log "fetch failed once; retry"; sleep 15; }
    done
    if [ $got = 1 ]; then
      mv "$IMG.new" "$IMG"
      cp "$IMG" "$LAST" 2>/dev/null
      min=$(date +%M); min=${min#0}
      full=0
      # 最初・毎時 0〜4 分・お休み中の帯を出していた後は、点滅ありで全体を描き直す
      { [ "$first" = 1 ] || [ "$min" -lt 5 ] || [ "$offline" = 1 ]; } && full=1
      show "$IMG" "$full"
      log "ok batt=$B chg=$C hold=$H plug=$P full=$full"
      first=0; offline=0; fails=0
      # お休み中の帯をまだ持っていなければ取っておく
      [ -s "$OFF" ] || curl -s -f --connect-timeout 5 --max-time 60 -o "$OFF" "$BASE/kindle_off.png?rot=$ROT" || rm -f "$OFF"
    else
      fails=$((fails + 1))
      log "fetch failed ($fails) batt=$B chg=$C $(wifi_state)"
      if [ ! -f "$IMG" ]; then
        eips 2 2 "Cannot get image: $URL" >/dev/null
      elif [ "$offline" != 1 ] && [ $fails -ge 2 ] && [ -s "$OFF" ]; then
        # 「お休み中」の帯は 2 回続けて取れなかったときだけ（1 回だけの失敗では出さない）
        # 前の画面の上端（横置きで見たとき）に帯を重ねる。270 は縦の画面の左端、90 は右端
        if [ "$ROT" = 270 ]; then ox=0; else ox=708; fi
        command -v fbink >/dev/null 2>&1 && { fbink -q -w -g file="$OFF",x=$ox,y=0 2>/dev/null || fbink -q -g file="$OFF",x=$ox,y=0; }
        sleep 2
      fi
      [ $fails -ge 2 ] && offline=1
    fi
    # 次の 5 分の区切り（:00・:05…）まで眠る（毎時 0 分の描き直しがずれないように）。1 分より近ければその次
    now=$(date +%s)
    wait_s=$((EVERY - now % EVERY))
    [ $wait_s -lt 60 ] && wait_s=$((wait_s + EVERY))
    nap "$wait_s"
  done
}

# 裏で動く方（下で自分自身を run を付けて起動し直す。$$ がこのプロセスを指すように）
if [ "$1" = run ]; then
  cd /
  main
  exit 0
fi

# もう動いていればそれを止めるだけ
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  kill -TERM "$(cat "$PID")"
  exit 0
fi

# 本の一覧から起動されたので、裏で動かして、すぐ戻る。
# 自分を /tmp に写してそこから動かす（保存領域 /mnt/us の中から動いていると、ケーブルを挿したときに Kindle が保存領域を
# Mac に渡せず、再起動してしまった。2026-11-27）。記録などは書くときだけ開くので、使いっぱなしにはならない
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
cp "$SELF" /tmp/fxp_dash.sh
cd /
nohup sh /tmp/fxp_dash.sh run </dev/null >/dev/null 2>&1 &
exit 0
