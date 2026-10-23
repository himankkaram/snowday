#!/usr/bin/env bash
# Runs every time someone opens this Codespace: makes .env, makes the game port public, starts the game.
set -u
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  key="${SNOWDAY_HOST_KEY:-cs-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  sed -i "s|^HOST_KEY=.*|HOST_KEY=${key}|" .env
fi
key="$(grep '^HOST_KEY=' .env | cut -d= -f2-)"
base="https://${CODESPACE_NAME:-localhost}-5173.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"

# Phones aren't logged in to GitHub, so the game port must be public. Retry until the port exists.
(
  for _ in $(seq 1 30); do
    sleep 2
    if gh codespace ports visibility 5173:public -c "${CODESPACE_NAME:-}" >/dev/null 2>&1; then
      echo ""
      echo "[snowday] Port 5173 is public. Phones can join by scanning the QR code."
      exit 0
    fi
  done
  echo ""
  echo "[snowday] Could not make port 5173 public automatically."
  echo "[snowday] Open the PORTS tab, right-click port 5173, Port Visibility -> Public."
) &

cat <<MSG

==================================================================
 SNOW DAY is starting. When you see "VITE ready", open the host
 screen (Ctrl/Cmd + click the link):

   ${base}/host.html?key=${key}

 Then scan the QR code on that page with a phone.
 Stop the game: Ctrl+C. Start it again: npm run dev
==================================================================

MSG

exec npm run dev
