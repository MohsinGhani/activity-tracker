#!/bin/sh
set -e
rm -f /tmp/.X99-lock

echo "[start] virtual display ${DISPLAY} (${SCREEN_RESOLUTION})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_RESOLUTION}" -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &
x11vnc -display "${DISPLAY}" -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

echo "[start] open http://localhost:6080/vnc.html?autoconnect=1&resize=scale"

# Keep the app running; relaunch if it is closed or crashes.
while true; do
  dbus-launch --exit-with-session npx electron . --no-sandbox --disable-gpu --disable-dev-shm-usage || true
  echo "[start] Electron exited - restarting in 3s"
  sleep 3
done
