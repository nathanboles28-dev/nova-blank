#!/bin/bash
# Nova "Now playing" sender. The little "Nova Music" app reads Apple Music every few seconds and hands the
# details to this script, which only sends a message when something changes: a new song, pause/play, or a skip.
# Nothing else from your library ever leaves this Mac.
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/nova-music.env"; SF="$DIR/.np-state"
last_key=""; last_pos=0; last_t=0; sent_day=""; sent=0; [ -f "$SF" ] && . "$SF"
DEV="${NOVA_DEVICE:-Mac}"; CAP="${DAILY_CAP:-200}"
esc(){ printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
num(){ case "$1" in ''|*[!0-9-]*) echo 0;; *) echo "$1";; esac; }
now=$(date +%s)
IFS=$'\037' read -r st nm ar al yr du ps pid <<EOF2
$1
EOF2
if [ "$st" = error ]; then printf '%s  %s\n' "$(date)" "$nm" > "$DIR/nova-music-error.txt"; fi
# older macOS can hand back the raw code instead of the word
case "$st" in *kPSP*|*kPSF*|*kPSR*) st=playing;; *kPSp*) st=paused;; esac
case "$st" in playing|paused) ;; *) st=stopped;; esac
# AppleScript gives decimals (with your Mac's decimal mark): keep whole seconds
du=$(num "${du%%[.,]*}"); ps=$(num "${ps%%[.,]*}"); yr=$(num "$yr")
key="$st|$pid|$nm|$ar"; jump=0
if [ "$st" = playing ] && [ "$key" = "$last_key" ]; then
  diff=$((ps - (last_pos + now - last_t))); [ "${diff#-}" -gt 6 ] && jump=1
fi
if [ "$key" != "$last_key" ] || [ "$jump" = 1 ]; then
  if [ "$st" = stopped ]; then body="{\"state\":\"stopped\",\"at\":$now,\"dev\":\"$(esc "$DEV")\"}"
  else body="{\"state\":\"$st\",\"title\":\"$(esc "$nm")\",\"artist\":\"$(esc "$ar")\",\"album\":\"$(esc "$al")\",\"year\":$yr,\"dur\":$du,\"pos\":$ps,\"at\":$now,\"dev\":\"$(esc "$DEV")\"}"; fi
  d=$(date +%Y-%m-%d); [ "$d" != "$sent_day" ] && { sent_day=$d; sent=0; }
  # nothing to announce when it starts up with nothing playing; daily safety limit for the free channel
  if { [ -n "$last_key" ] || [ "$st" != stopped ]; } && [ "$sent" -lt "$CAP" ]; then
    curl -s -m 8 -d "$body" "https://ntfy.sh/${NOVA_TOPIC}-music" >/dev/null 2>&1 && sent=$((sent+1))
  fi
  last_key="$key"
fi
last_pos=$ps; last_t=$now
printf 'last_key=%q\nlast_pos=%q\nlast_t=%q\nsent_day=%q\nsent=%q\n' "$last_key" "$last_pos" "$last_t" "$sent_day" "$sent" > "$SF"
