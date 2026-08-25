#!/bin/bash
# Runs on swipe-bot-vm after the repo is already at the desired commit (see ~/deploy.sh, which
# does the git fetch/reset and then execs into this file fresh — never edit ~/deploy.sh itself
# for anything beyond that bootstrap, since a script that rewrites itself mid-run via git reset
# is a classic bash footgun).
set -euo pipefail
cd ~/austria-apartment-hunt

npm install
npm run build --workspace=apt-hunter
npm run build --workspace=immoscout-mcp
npm run build --workspace=swipe-bot

sudo systemctl restart swipe-bot
sleep 3
sudo systemctl is-active swipe-bot

# Smoke test: the deploy is only a success if the bot is actually talking to Telegram afterward,
# not just "the process started". A working long-poll shows ok:true here even before the process
# calls launch() itself, since getWebhookInfo only asks Telegram about webhook config, not the bot.
TOKEN=$(grep TELEGRAM_BOT_TOKEN swipe-bot/.env | cut -d= -f2)
RESPONSE=$(curl -sf "https://api.telegram.org/bot${TOKEN}/getWebhookInfo")
echo "$RESPONSE"
echo "$RESPONSE" | grep -q '"ok":true' || { echo "SMOKE TEST FAILED: getWebhookInfo did not return ok:true"; exit 1; }
echo "smoke test passed"
