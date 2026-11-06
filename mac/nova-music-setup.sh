#!/bin/bash
# One-time setup for Nova "Now playing" on the Mac you play Apple Music on.
# Makes a tiny invisible app, "Nova Music", that checks Apple Music every 3 seconds. It starts by itself at login.
SRC="$(cd "$(dirname "$0")" && pwd)"; DEST="$HOME/Library/Application Support/Nova"; mkdir -p "$DEST"
cp "$SRC/nova-music.sh" "$DEST/nova-music.sh" || { echo "Couldn't find nova-music.sh next to this file."; exit 1; }
chmod +x "$DEST/nova-music.sh"
echo "Nova Now playing setup"
ASK=1
if [ -f "$DEST/nova-music.env" ] && grep -q NOVA_TOPIC "$DEST/nova-music.env"; then
  read -r -p "Keep the channel name you entered before? (Y/n): " KEEP; case "$KEEP" in n|N) ;; *) ASK=0;; esac
fi
if [ "$ASK" = 1 ]; then
  read -r -p "Nova channel name (the same one the remote uses): " TOPIC; TOPIC="${TOPIC##*#topic=}"; TOPIC="${TOPIC//[[:space:]]/}"
  [ -z "$TOPIC" ] && { echo "No channel name entered, nothing changed."; exit 1; }
  read -r -p "Name to show for this Mac [Mac]: " DEV; DEV=${DEV:-Mac}
  printf 'NOVA_TOPIC="%s"\nNOVA_DEVICE="%s"\nDAILY_CAP=200\n' "$TOPIC" "$DEV" > "$DEST/nova-music.env"; chmod 600 "$DEST/nova-music.env"
fi
rm -f "$DEST/.np-state"
# stop the old background helper (from the first version) if it's there
launchctl bootout "gui/$(id -u)/com.nova.music" 2>/dev/null; pkill -f "Nova Music.app/Contents/MacOS/applet" 2>/dev/null
# the app: reads Apple Music, hands the details to nova-music.sh
cat > "$DEST/nova-music.applescript" <<'OSA'
property helper : ""
on run
	set helper to (POSIX path of (path to home folder)) & "Library/Application Support/Nova/nova-music.sh"
end run
on idle
	if helper is "" then set helper to (POSIX path of (path to home folder)) & "Library/Application Support/Nova/nova-music.sh"
	set vSep to (ASCII character 31)
	set vOut to "off"
	try
		if application "Music" is running then
			tell application "Music"
				set vPS to player state
				if vPS is playing or vPS is fast forwarding or vPS is rewinding then
					set vState to "playing"
				else if vPS is paused then
					set vState to "paused"
				else
					set vState to "stopped"
				end if
				if vState is "stopped" then
					set vOut to "stopped"
				else
					set vName to ""
					set vArtist to ""
					set vAlbum to ""
					set vYear to 0
					set vDur to 0
					set vPid to ""
					set vPos to 0
					try
						set vTrack to current track
						set vName to name of vTrack
						set vArtist to artist of vTrack
						set vAlbum to album of vTrack
						set vYear to year of vTrack
						set vDur to duration of vTrack
						set vPid to persistent ID of vTrack
					end try
					try
						if vName is "" then set vName to current stream title
					end try
					try
						set vPos to player position
					end try
					set vOut to vState & vSep & vName & vSep & vArtist & vSep & vAlbum & vSep & (vYear as text) & vSep & (vDur as text) & vSep & (vPos as text) & vSep & vPid
				end if
			end tell
		end if
	on error vErr
		set vOut to "error" & vSep & vErr
	end try
	try
		do shell script "/bin/bash " & quoted form of helper & " " & quoted form of vOut
	end try
	return 3
end idle
OSA
APP="$DEST/Nova Music.app"; rm -rf "$APP"
osacompile -s -o "$APP" "$DEST/nova-music.applescript" || { echo "Couldn't build the Nova Music app."; exit 1; }
PB=/usr/libexec/PlistBuddy; IP="$APP/Contents/Info.plist"
$PB -c "Add :LSUIElement bool true" "$IP" 2>/dev/null || $PB -c "Set :LSUIElement true" "$IP"
$PB -c "Add :NSAppleEventsUsageDescription string Nova reads what's playing in Apple Music to show it on your dashboard." "$IP" 2>/dev/null
$PB -c "Set :CFBundleName Nova Music" "$IP" 2>/dev/null
codesign --force --deep --sign - "$APP" 2>/dev/null
# start it at every login, and keep it running
PL="$HOME/Library/LaunchAgents/com.nova.music.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nova.music</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/applet</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PL" 2>/dev/null || launchctl load -w "$PL"
echo
echo "Done. Play a song in Apple Music now."
echo "A box should ask: \"Nova Music\" wants access to control \"Music\". Click OK (or Allow)."
echo "If no box shows up, open System Settings > Privacy & Security > Automation and turn on Music under Nova Music."
