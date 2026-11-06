#!/bin/bash
# Nova "Home tech" stats: sends a few numbers about this Mac to your Nova relay.
# Only numbers and drive names leave this Mac: never file names or anything inside files.
# Settings live in nova-stats.env next to this script (created by nova-stats-setup.sh).
# cron starts scripts with a bare PATH, which hides ping, sysctl, system_profiler and ipconfig
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"; ENV="$DIR/nova-stats.env"; ST="$DIR/.nova-stats"
[ -f "$ENV" ] || { echo "Run nova-stats-setup.sh first"; exit 1; }
. "$ENV"; mkdir -p "$ST"
now=$(date +%s)
esc(){ printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
num(){ case "$1" in ''|*[!0-9.-]*) echo null;; *) echo "$1";; esac; }

# ---------- internet: ping every run, remember outages (only on the Mac with PING=1) ----------
ping_ms=null
if [ "$PING" = "1" ]; then
  out=$(ping -c 3 -q -t 6 1.1.1.1 2>/dev/null); rx=$(printf '%s' "$out" | awk '/packets received/{print $4}')
  if [ "${rx:-0}" = "0" ]; then out=$(ping -c 3 -q -t 6 8.8.8.8 2>/dev/null); rx=$(printf '%s' "$out" | awk '/packets received/{print $4}'); fi
  if [ "${rx:-0}" != "0" ]; then
    ping_ms=$(printf '%s' "$out" | awk -F'/' '/round-trip/{printf "%.0f", $5}')
    echo "$now $ping_ms" >> "$ST/pings"; tail -n 60 "$ST/pings" > "$ST/pings.t" && mv "$ST/pings.t" "$ST/pings"
    if [ -f "$ST/down_since" ]; then s=$(cat "$ST/down_since"); echo "$s $now" >> "$ST/outages"; tail -n 10 "$ST/outages" > "$ST/o.t" && mv "$ST/o.t" "$ST/outages"; rm -f "$ST/down_since"; fi
  else
    [ -f "$ST/down_since" ] || echo "$now" > "$ST/down_since"
    exit 0   # no internet: nothing to send right now
  fi
fi

# ---------- the slower stats: every ~5 minutes ----------
last=$(cat "$ST/last_full" 2>/dev/null || echo 0)
full=0; { [ $((now - last)) -ge 270 ] || [ -t 1 ]; } && full=1   # always full when run by hand in Terminal

drives="" cpu=null mem=null memgb=null up=null wifi="" tm="" speed="" kopia=""
if [ "$full" = "1" ]; then
  echo "$now" > "$ST/last_full"
  # drives: the built-in disk and everything plugged in (not network shares or system volumes)
  seen=" "
  while IFS=$'\t' read -r fs kb used avail mnt; do
    case "$fs" in //*|map*|devfs*) continue;; esac
    case "$mnt" in
      /System/Volumes/Data) name="Macintosh HD";;
      /Volumes/*) name="${mnt#/Volumes/}"; case "$name" in .*|com.apple*|Recovery*|Preboot*|VM*|Update*|xarts*|iSCPreboot*|Hardware*|*TimeMachine*|*"Time Machine Backups"*) continue;; esac;;
      *) continue;;
    esac
    # volumes that share one disk (e.g. "Macintosh HD - Data", an old "Macintosh HD 1") are the same space: list once
    case "$fs" in /dev/disk*) box="${fs%%s[0-9]*}"; case "$seen" in *" $box "*) continue;; esac; seen="$seen$box ";; esac
    drives="$drives{\"name\":\"$(esc "$name")\",\"total\":$((kb*1024)),\"free\":$((avail*1024))},"
  done < <(df -k -P 2>/dev/null | awk 'NR>1{m=$6; for(i=7;i<=NF;i++) m=m" "$i; print $1"\t"$2"\t"$3"\t"$4"\t"m}')
  drives="[${drives%,}]"
  idle=$(top -l 2 -n 0 -s 1 2>/dev/null | awk '/CPU usage/{l=$0} END{match(l,/[0-9.]+% idle/); print substr(l,RSTART,RLENGTH-6)}')
  [ -n "$idle" ] && cpu=$(awk -v i="$idle" 'BEGIN{printf "%.0f", 100-i}')
  free=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2); print $2}')
  [ -n "$free" ] && mem=$((100 - free))
  memgb=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $1/1073741824}')
  boot=$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/^\{ sec = ([0-9]+).*/\1/'); [ -n "$boot" ] && up=$((now - boot))
  # Wi-Fi (if this Mac is on Wi-Fi)
  wi=$(system_profiler SPAirPortDataType 2>/dev/null | awk '/Current Network Information:/{f=1;next} f&&/Other Local Wi-Fi Networks:/{exit} f')
  sig=$(printf '%s' "$wi" | awk -F': ' '/Signal \/ Noise/{print $2; exit}' | sed -E 's/^(-?[0-9]+) dBm.*/\1/')
  ch=$(printf '%s' "$wi" | awk -F': ' '/Channel/{print $2; exit}')
  rate=$(printf '%s' "$wi" | awk -F': ' '/Transmit Rate/{print $2; exit}')
  [ -n "$sig" ] && wifi="{\"signal\":$(num "$sig"),\"channel\":\"$(esc "$ch")\",\"rate\":$(num "$rate")}"
  # Time Machine: where it backs up to and when it last finished
  dest=$(tmutil destinationinfo 2>/dev/null | awk -F': *' '/^Name/{print $2; exit}')
  if [ -n "$dest" ]; then
    lb=$(tmutil latestbackup 2>/dev/null | grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}' | tail -1)
    [ -z "$lb" ] && lb=$(defaults read /Library/Preferences/com.apple.TimeMachine 2>/dev/null | grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | sort | tail -1 | tr ' :' '--' | sed -E 's/-([0-9]{2})-([0-9]{2})-([0-9]{2})$/-\1\2\3/')
    lbt=null; [ -n "$lb" ] && lbt=$(date -j -f '%Y-%m-%d-%H%M%S' "$lb" +%s 2>/dev/null || echo null)
    run=$(tmutil status 2>/dev/null | awk -F'= ' '/Running/{gsub(";","",$2); print $2; exit}')
    tm="{\"dest\":\"$(esc "$dest")\",\"last\":$lbt,\"running\":$([ "$run" = "1" ] && echo true || echo false)}"
  fi
  # Kopia (the Kopia app): when its last snapshot finished. Checked about once an hour, since each check asks the cloud.
  K="/Applications/KopiaUI.app/Contents/Resources/server/kopia"; [ -x "$K" ] || K=$(command -v kopia 2>/dev/null)
  KC="$HOME/Library/Application Support/kopia/repository.config"
  if [ -n "$K" ] && [ -x "$K" ] && [ -f "$KC" ]; then
    kl=$(cat "$ST/kopia_at" 2>/dev/null || echo 0)
    if [ $((now - kl)) -ge 3300 ] || [ ! -f "$ST/kopia" ] || [ -t 1 ]; then
      echo "$now" > "$ST/kopia_at"
      if js=$("$K" --config-file="$KC" snapshot list --all --json 2>"$ST/kopia_err.txt"); then
        et=$(printf '%s' "$js" | grep -Eo '"endTime": *"[^"]+"' | sed -E 's/.*"([0-9T:-]+)[^"]*"$/\1/' | sort | tail -1)
        n=$(printf '%s' "$js" | grep -Eo '"endTime"' | wc -l | tr -d ' ')
        kt=null; [ -n "$et" ] && kt=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$et" +%s 2>/dev/null || echo null)
        kd=$(grep -Eo '"type": *"[A-Za-z0-9]+"' "$KC" | head -1 | sed -E 's/.*"([A-Za-z0-9]+)"$/\1/')
        case "$kd" in b2) kd=Backblaze;; s3) kd=S3;; filesystem) kd="a drive";; gcs) kd="Google Cloud";; azureBlob) kd=Azure;; *) kd="${kd:-the cloud}";; esac
        printf '{"last":%s,"dest":"%s","count":%s}' "$kt" "$kd" "${n:-0}" > "$ST/kopia"
      fi
    fi
    [ -f "$ST/kopia" ] && kopia=$(cat "$ST/kopia")
  fi
  # speed test every few hours (only on the Mac with SPEEDTEST=1); macOS has one built in
  if [ "$SPEEDTEST" = "1" ]; then
    lst=$(cat "$ST/last_speed" 2>/dev/null || echo 0)
    if [ $((now - lst)) -ge $(( ${SPEED_HOURS:-3} * 3600 )) ]; then
      echo "$now" > "$ST/last_speed"
      j=$(networkQuality -c -s 2>/dev/null)
      dl=$(printf '%s' "$j" | grep -Eo '"dl_throughput" *: *[0-9.]+' | grep -Eo '[0-9.]+$')
      ul=$(printf '%s' "$j" | grep -Eo '"ul_throughput" *: *[0-9.]+' | grep -Eo '[0-9.]+$')
      [ -n "$dl" ] && { echo "$now $(awk -v d="$dl" 'BEGIN{printf "%.0f", d/1e6}') $(awk -v u="${ul:-0}" 'BEGIN{printf "%.0f", u/1e6}')" >> "$ST/speeds"; tail -n 16 "$ST/speeds" > "$ST/s.t" && mv "$ST/s.t" "$ST/speeds"; }
    fi
  fi
fi
list(){ [ -f "$1" ] && awk -v f="$2" 'BEGIN{ORS=""; print "["} {if(NR>1) print ","; if(f==3) print "["$1","$2","$3"]"; else print "["$1","$2"]"} END{print "]"}' "$1" || echo "[]"; }
# only send on the 5-minute runs (pings and outages are kept here and go out with them); keeps Cloudflare KV under its free daily limit
[ "$full" = "1" ] || exit 0
body="{\"name\":\"$(esc "$NOVA_NAME")\",\"at\":$now,\"full\":$full,\"model\":\"$(esc "$(sysctl -n hw.model 2>/dev/null)")\",\"os\":\"$(esc "$(sw_vers -productVersion 2>/dev/null)")\""
[ "$full" = "1" ] && body="$body,\"drives\":$drives,\"cpu\":$cpu,\"mem\":$mem,\"memgb\":$(num "$memgb"),\"up\":$up${wifi:+,\"wifi\":$wifi}${tm:+,\"tm\":$tm}${kopia:+,\"kopia\":$kopia}"
[ "$PING" = "1" ] && body="$body,\"ping\":$ping_ms,\"pings\":$(list "$ST/pings" 2),\"outages\":$(list "$ST/outages" 2)"
[ "$SPEEDTEST" = "1" ] && body="$body,\"speeds\":$(list "$ST/speeds" 3)"
body="$body}"
curl -s -m 20 -X POST -H 'Content-Type: application/json' --data-binary "$body" "${NOVA_RELAY%/}/stats?key=$(printf '%s' "$NOVA_KEY" | sed 's/ /%20/g')" >/dev/null 2>&1
