#!/bin/bash
# One-time setup for Nova "Home tech" on this Mac.
DIR="$(cd "$(dirname "$0")" && pwd)"; chmod +x "$DIR/nova-stats.sh"
echo "Nova Home tech setup"
read -r -p "Name for this Mac exactly as it should appear (e.g. Kitchen Mac): " NAME
read -r -p "Nova relay URL (your Worker, e.g. https://nova-relay.yourname.workers.dev): " RELAY; [ -z "$RELAY" ] && { echo "The relay URL is needed."; exit 1; }
read -r -s -p "Nova key (the same CAL_KEY the dashboard uses): " KEY; echo
read -r -p "Run the internet speed test and outage watch on this Mac? Only say yes on ONE Mac (y/N): " ONE
SP=0; PG=0; case "$ONE" in y|Y) SP=1; PG=1;; esac
printf 'NOVA_NAME="%s"\nNOVA_RELAY="%s"\nNOVA_KEY="%s"\nSPEEDTEST=%s\nPING=%s\nSPEED_HOURS=3\n' "$NAME" "$RELAY" "$KEY" "$SP" "$PG" > "$DIR/nova-stats.env"
chmod 600 "$DIR/nova-stats.env"
# every minute on the Mac that watches the internet, every 5 minutes on the others
LINE="$([ "$PG" = 1 ] && echo '*' || echo '*/5') * * * * /bin/bash \"$DIR/nova-stats.sh\" >/dev/null 2>\"$DIR/.nova-stats-error.txt\""
( crontab -l 2>/dev/null | grep -v 'nova-stats.sh'; echo "$LINE" ) | crontab -
echo "Added to cron: $LINE"
echo "Sending the first update now..."; /bin/bash "$DIR/nova-stats.sh" && echo "Done. It shows up on Nova's Home tech page within a few minutes."
