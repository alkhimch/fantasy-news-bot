# Fantasy news → Telegram

Sends you a Telegram message when one of your fantasy players shows up in new news.
It uses only the Python standard library (3.8+), so there is nothing to install.

**Sources**
| Source | Default | Notes |
|---|---|---|
| Rotowire NBA RSS | on | Classic fantasy blurbs. Many of them are written from beat-reporter tweets. |
| ESPN Fantasy player news | on | Injury and role updates (unofficial endpoint). |
| ESPN NBA news | on | Articles tagged with athletes. |
| X / Twitter API | off | Needs a **paid** X API plan, because search is not on the free tier. Searches tweets from reporters you choose that mention your players. |
| Extra RSS feeds | empty | Any RSS/Atom URL, such as an RSSHub or rss.app feed of an X account. This is a free way to get tweets. |

## Setup (5 min)

1. **Create the bot:** in Telegram, message `@BotFather`, send `/newbot`, and copy the token.
2. `cp config.example.json config.json`, put the token in `telegram.bot_token`, and list your players.
3. Open your new bot in Telegram and send it `/start`.
4. Run `python3 bot.py --get-chat-id` and put the number it prints in `telegram.chat_id`.
5. Run `python3 bot.py --test-message`. You should get "✅ connected".
6. Run `python3 bot.py`. The first poll only indexes news that is already out, so you don't get a flood of old items. After that, you get alerts for new items only.

## Test it

```bash
python3 bot.py --test-message   # Telegram works?
python3 bot.py --test-alerts    # every source reachable? sends the newest 3 matches now, marked 🧪
```
`--test-alerts` doesn't change saved state, so you can run it as often as you like. If it says no current news matches your players, `/add` a player who is in today's news.
After the bot is running, send `/status` in Telegram to see whether each source is working.

## Where to run it

- **Free, recommended: Netlify.** The `netlify/` folder has a JavaScript version of the bot:
  - a scheduled function checks the news every 2 minutes
  - a Telegram webhook answers `/add`, `/remove`, `/list`, `/status` and `/test` instantly
  - Netlify Blobs stores the player list and which news was already sent

  Set the environment variables `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `PLAYERS` in Netlify. For step-by-step setup, see [deploy/claude-in-chrome-prompt.md](deploy/claude-in-chrome-prompt.md). Run the tests with `npm test`.
- **Manual fallback: GitHub Actions.** `.github/workflows/news.yml` runs `bot.py --once` every 5 minutes. GitHub often starts these runs late, so alerts arrive 5–15 minutes after the news. Settings come from GitHub Secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, and the variable `PLAYERS`. The bot's memory of sent news is saved on the `state` branch. A public repo gets unlimited free minutes. A private repo should use `*/30` to stay within 2,000 minutes per month.
- **Real time (2-minute checks): any always-on Linux machine** (a VPS, Oracle Cloud Always Free, or a home PC/Raspberry Pi):
  `git clone` the repo, then run `bash deploy/setup.sh`. It creates the config, tests it and installs the systemd service.

## Keep it running

Use a systemd user service:
```bash
mkdir -p ~/.config/systemd/user
cp fantasy-news-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fantasy-news-bot
loginctl enable-linger $USER          # keep running after logout
journalctl --user -u fantasy-news-bot -f
```
Or use cron instead (Telegram commands then only get answered every 2 min):
`*/2 * * * * cd ~/projects/fantasy-news-bot && python3 bot.py --once >> bot.log 2>&1`

## Telegram commands

Send these to the bot. It only answers your own `chat_id`.

- `/list`: shows the players you track
- `/add Name` or `/add Name1, Name2`: starts tracking players
- `/remove Name`: stops tracking a player (aliases work)
- `/status`: shows whether each source is working

You manage the player list from Telegram after the first run. It is stored in `data/players.json`. The `players` field in `config.json` only seeds the list the first time.

## Getting tweets

- **Paid X API:** set `sources.twitter.enabled: true` and `bearer_token`, and edit `accounts`. Polling is throttled by `interval_seconds` (default 300) to save quota.
- **Free route:** create an RSS feed of a reporter's X timeline with rss.app or a self-hosted RSSHub, then add it:
  ```json
  "extra_rss": {"feeds": [{"name": "X @ShamsCharania", "url": "https://rss.app/feeds/XXXX.xml"}]}
  ```

## Matching

Names are matched case-insensitively and without accents ("Jokić" matches "Jokic"), as whole words, and with or without Jr./Sr./II/III. Add `aliases` for nicknames, e.g. `{"name": "Shai Gilgeous-Alexander", "aliases": ["SGA"]}`.
Only matching on a last name is not supported on purpose, because it would trigger on every "Jackson" or "Williams".
