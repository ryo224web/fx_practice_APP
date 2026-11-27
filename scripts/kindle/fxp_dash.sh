#!/bin/sh
# Name: FX ダッシュボード
# Author: fx_practice
# DontUseFBInk
#
# 脱獄した Kindle Paperwhite 2 で、Mac mini の FX Practice が作る画像（指標・天気）を 5 分ごとに取ってきて全画面に出す。
# 本の一覧のこのファイルをタップすると始まる。
#   5 分ごとに起きる → Wi-Fi がつながるのを待つ → 電池の残量を伝えて画像を取る → 画面を書き換える → すぐ眠る（電池を持たせるため）
#   書き換えはふだん点滅なし。毎時 0〜4 分の回だけ点滅ありで全体を描き直して残像を消す
#   ケーブルを挿したままなら、電池 80% で充電を止め、40% で再開する（ダッシュボードを止めると充電は許可に戻す）
#   止めるとき: 電源ボタンを 1 回押す（電源ボタンの入力を見張っている。充電中などで眠れないときは画面のタップでも止まる）
#   戻らなくなったら: 電源ボタンを 20 秒ほど押し続けると再起動する（ふつうの Kindle に戻る）
# 置き場所: Kindle の documents フォルダ（Mac mini で npm run deploy-kindle）。記録は Kindle の一番上の fxp_dash.log。

# Mac mini の Wi-Fi のアドレスと、Kindle の向き（270: Kindle の下側（USB の口）を左にして横に置く / 90: 右に置く）
URL="http://192.168.40.227:8090/kindle.png"
ROT=270
EVERY=300
# ケーブルを挿したままのとき、電池がこの % 以上で充電を止め、この % 以下で再開する（満充電のまま置くと電池が傷むため）
CHG_STOP=80
CHG_START=40
# 1: 更新の間は眠る（電池が持つ。眠る間は Wi-Fi を切る）/ 0: 起きたまま待つ（画面をタップしても止まる）
SLEEP=1

# 脱獄（WinterBreak2）が入れた fbink（画像を画面に出す道具）
export PATH="/mnt/us/libkh/bin:$PATH"

LOG=/mnt/us/fxp_dash.log
PID=/tmp/fxp_dash.pid
IMG=/tmp/fxp_dash.png
AWAKE=/tmp/fxp_dash.awake
# 眠っている間・起きた直後に届いた電源ボタンの入力の時刻
KEYF=/tmp/fxp_dash.key

log() {
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
  if [ "$a" = 1 ] && [ "$b" -ge "$CHG_STOP" ]; then
    echo 0 > "$ALLOW" && log "charging off at ${b}%"
  elif [ "$a" = 0 ] && [ "$b" -le "$CHG_START" ]; then
    echo 1 > "$ALLOW" && log "charging on at ${b}%"
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

# Wi-Fi がつながるのを 30 秒まで待つ（眠りから覚めた直後はつながっていない）
wifi_ready() {
  lipc-set-prop com.lab126.wifid enable 1 2>/dev/null
  i=0
  while [ $i -lt 30 ]; do
    [ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" = CONNECTED ] && return 0
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

# 時計で起こす（RTC）。rtc1 があればそれ、無ければ rtc0
RTC=/sys/class/rtc/rtc1
[ -e "$RTC/wakealarm" ] || RTC=/sys/class/rtc/rtc0

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
      lipc-set-prop com.lab126.wifid enable 0 2>/dev/null
      echo 0 > "$AWAKE"
      rm -f "$KEYF"
      sleep 1
      echo 0 > "$RTC/wakealarm" 2>/dev/null
      if echo "+$left" > "$RTC/wakealarm" 2>/dev/null && echo mem > /sys/power/state 2>/dev/null; then
        tries=$((tries + 1))
        # 起きたときに届く電源ボタンの入力を待つ
        sleep 2
        late=$((target - $(date +%s)))
        if [ $late -gt 15 ]; then
          # 予定より早く起きて電源ボタンの入力があれば、押して起こされた
          [ -f "$KEYF" ] && { log "power button (woke ${late}s early)"; stop_dash; }
          log "woke early: ${late}s left"
        fi
        # 予定どおり時計で起きたときも電源ボタンの入力が 1 回届く（2026-11-27 にこれで止まった）ので、それは無視する
        rm -f "$KEYF"
        continue
      fi
      log "cannot suspend (charging=$(charging)); awake for ${left}s"
    fi
    echo 1 > "$AWAKE"
    sleep "$left" &
    wait $!
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
  rm -f "$PID" "$AWAKE" "$KEYF"
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
  trap stop_dash TERM INT

  # 電源ボタンを押したら止める（眠っているときに押すと、起きたあとでその入力が届く）
  KEY=$(input_dev onkey)
  # 起きたまま待っているとき（充電中で眠れないときなど）は、画面をタップしても止める
  TOUCH=$(input_dev 'touch|zforce|cyttsp|elan')
  log "input devices: $(grep '^N:' /proc/bus/input/devices 2>/dev/null | tr '\n' ' ') key=${KEY:-none} touch=${TOUCH:-none}"
  if [ -n "$KEY" ]; then
    # 起きているとき（AWAKE=1）に押されたらすぐ止める。眠っている間・起きた直後は時刻を残すだけ（nap が決める）
    ( while head -c 16 "$KEY" >/dev/null 2>&1; do
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

  first=1
  while :; do
    B=$(battery)
    charge_control "$B"
    C=$(charging); H=$(charge_held)
    if wifi_ready && curl -s -f --max-time 40 -o "$IMG.new" "$URL?rot=$ROT&batt=$B&chg=$C&hold=$H"; then
      mv "$IMG.new" "$IMG"
      min=$(date +%M); min=${min#0}
      full=0
      { [ "$first" = 1 ] || [ "$min" -lt 5 ]; } && full=1
      show "$IMG" "$full"
      log "ok batt=$B chg=$C hold=$H full=$full"
      first=0
    else
      log "fetch failed batt=$B chg=$C wifi=$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)"
      [ -f "$IMG" ] || eips 2 2 "Cannot get image: $URL" >/dev/null
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
  main
  exit 0
fi

# もう動いていればそれを止めるだけ
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
  kill -TERM "$(cat "$PID")"
  exit 0
fi

# 本の一覧から起動されたので、裏で動かして、すぐ戻る
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
nohup sh "$SELF" run </dev/null >/dev/null 2>&1 &
exit 0
