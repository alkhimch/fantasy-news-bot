#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu/Debian VM.
# Run from anywhere inside the cloned repo:  bash deploy/setup.sh
# Safe to re-run: keeps an existing config.json and just reinstalls/restarts the service.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$PWD"
PY="$(command -v python3 || true)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [ -z "$PY" ]; then
  say "Installing python3"
  sudo apt-get update -y && sudo apt-get install -y python3
  PY="$(command -v python3)"
fi

# ---------------------------------------------------------------- config.json
if [ -f config.json ]; then
  say "config.json already exists - keeping it"
else
  say "Creating config.json"
  read -rsp "Paste your Telegram bot token (from @BotFather; input is hidden): " TOKEN; echo
  TOKEN="$(echo "$TOKEN" | tr -d '[:space:]')"
  curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe" >/dev/null \
    || die "Telegram rejected that token. Check it in @BotFather and re-run."
  read -rp "Your players, comma separated (e.g. Nikola Jokic, Victor Wembanyama): " PLAYERS
  TOKEN="$TOKEN" PLAYERS="$PLAYERS" "$PY" - <<'PY'
import json, os
cfg = json.load(open("config.example.json"))
cfg["telegram"]["bot_token"] = os.environ["TOKEN"]
cfg["telegram"]["chat_id"] = None
cfg["players"] = [p.strip() for p in os.environ["PLAYERS"].split(",") if p.strip()]
json.dump(cfg, open("config.json", "w"), indent=2)
PY
  chmod 600 config.json
fi

# ---------------------------------------------------------------- chat id
HAS_CHAT=$("$PY" -c 'import json; print(1 if json.load(open("config.json"))["telegram"].get("chat_id") else 0)')
if [ "$HAS_CHAT" = "0" ]; then
  say "Open your bot in Telegram and send it /start  (waiting up to 5 minutes...)"
  CHAT_ID=""
  for _ in $(seq 1 60); do
    CHAT_ID=$("$PY" bot.py --get-chat-id 2>/dev/null | sed -n 's/^chat_id=\(-\{0,1\}[0-9][0-9]*\).*/\1/p' | head -n1 || true)
    [ -n "$CHAT_ID" ] && break
    sleep 5
  done
  [ -n "$CHAT_ID" ] || die "No message reached the bot. Send it /start in Telegram, then re-run this script."
  CHAT_ID="$CHAT_ID" "$PY" - <<'PY'
import json, os
cfg = json.load(open("config.json"))
cfg["telegram"]["chat_id"] = int(os.environ["CHAT_ID"])
json.dump(cfg, open("config.json", "w"), indent=2)
PY
  echo "chat_id = $CHAT_ID"
fi

# ---------------------------------------------------------------- smoke tests
say "Sending Telegram test message"
"$PY" bot.py --test-message
say "Checking news sources (sends up to 3 sample alerts marked TEST)"
"$PY" bot.py --test-alerts || echo "(test-alerts had problems - see above; continuing)"

# ---------------------------------------------------------------- service
say "Installing systemd user service"
sudo loginctl enable-linger "$USER"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$HOME/.config/systemd/user"
sed -e "s#%h/projects/fantasy-news-bot#${APP_DIR}#g" -e "s#/usr/bin/python3#${PY}#g" \
  fantasy-news-bot.service > "$HOME/.config/systemd/user/fantasy-news-bot.service"
systemctl --user daemon-reload
systemctl --user enable fantasy-news-bot >/dev/null
systemctl --user restart fantasy-news-bot
sleep 3
if systemctl --user is-active --quiet fantasy-news-bot; then
  say "DONE - bot is running. Send /status or /list to it in Telegram."
  echo "Logs:    journalctl --user -u fantasy-news-bot -f"
  echo "Update:  cd $APP_DIR && git pull && systemctl --user restart fantasy-news-bot"
else
  journalctl --user -u fantasy-news-bot -n 30 --no-pager || true
  die "Service failed to start (logs above)."
fi
