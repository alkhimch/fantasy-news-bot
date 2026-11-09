# Fantasy news → Telegram

Sends you a Telegram message when one of your fantasy players shows up in new news.
It uses only the Python standard library (3.8+), so there is nothing to install.

**Sources**
| Source | Default | Notes |
|---|---|---|
| Rotowire NBA RSS | on | Classic fantasy blurbs. Many of them are written from beat-reporter tweets. |
| ESPN Fantasy player news | off | Now only works per player, and repeats Rotowire's news. The Netlify version uses it per player instead. |
| ESPN NBA news | on | Articles tagged with athletes. Videos, game recaps and previews are skipped. |
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
  - a web page lets you pick players from every current NBA roster (loaded from ESPN, refreshed every 12 hours). Send `/web` to the bot to get its private link. The bot also sends the link once, the first time it runs.
  - storage: users, player lists and Bluesky follows in Supabase when it's set up (see [Storage](#storage-supabase)), otherwise in Netlify Blobs. Which news was already sent always stays in Netlify Blobs.
  - sources: ESPN's feed for each tracked player (about 10 latest Rotowire blurbs per player; reliable), Rotowire RSS (only the newest 5 items league-wide), and ESPN NBA headlines. When the same blurb arrives from two sources, it's sent once.
  - ESPN returns 403 to any User-Agent that contains "bot", so don't add it.
  - `/sources` in Telegram, or the "Эх сурвалжууд" section of the web page, shows every source, whether it is on or off, its last check time and item count, and any error.
  - Bluesky accounts: `/follow handle [all]`, `/unfollow handle` and `/following`, or the "Bluesky хаягууд" section of the web page. You get posts that mention your players, or every post in `all` mode. Defaults: `shamsbot.bsky.social` (an unofficial copy of Shams Charania's tweets) and `thesteinline.bsky.social` (Marc Stein). To replace them on first run, set the env var `FOLLOWS`. When you follow an account, its existing posts aren't sent.
  - X/Twitter can't be read for free: Nitter and XCancel are shut down, and X's embed endpoint only returns old popular tweets. So Bluesky is used instead.

  - Several users: see [Selling access](#selling-access-netlify) below.

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

## Selling access (Netlify)

The Netlify version serves several people from one bot. `TELEGRAM_CHAT_ID` is the owner: always active, and the only one who can open access for others.

1. A customer opens the bot and sends `/start` (or anything). A free 7-day trial starts right away (up to 10 players) and you get a "🎁 Туршилт эхэллээ" message. Each Telegram account gets one trial. When it ends, they get the plans, your payment details and their ID to put in the transfer description, and you get a "🆕 Шинэ хүсэлт" message when they write again. With `TRIAL_DAYS=0` there is no trial: step 1 goes straight to the payment details.
2. When the money arrives, open their access:
   - on the admin page: send `/admin` to the bot to get its private link. Pick the plan (10 players or unlimited) and an end date (end of season, 30 or 90 days, no expiry, or any date), then "Эрх нээх". You can also add a note such as when and how they paid. "Сунгах / солих" renews or changes the plan of a paying customer.
   - or in Telegram: `/approve <id>` (10 players, no expiry), `/approve <id> 30` (30 days) or `/approve <id> 30 unlimited`. Renewing without a plan keeps the current one.
3. The customer gets "✅ Таны эрх нээгдлээ" and their own private web link. From then on they use every command and the web page with their own players and Bluesky follows.
4. When the end date passes, the customer and you are told once and their alerts stop. If they write to the bot again, it shows up as a new request. Renew on the admin page ("Сунгах").

Other owner commands: `/users` lists customers, `/block <id>` closes access. Customers can only use the bot in a private chat.

Plans: the trial and the basic plan allow 10 players; the unlimited plan has no limit. `/add`, the web page and alerts all respect the limit (after a downgrade, only the first 10 players on the list get alerts). Customers see their plan, player count and prices with `/plan`. Customers from before plans existed count as basic.

### Admin login with a password

With Supabase set up (see [Storage](#storage-supabase)), the admin page also has an email + password login. The `/admin` link keeps working as a backup.

1. In Supabase, open **Authentication → Users → Add user → Create new user**. Enter an email and password, and tick **Auto Confirm User**. The email doesn't have to be a real mailbox.
2. In Supabase, open **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**.
3. In Netlify, add `ADMIN_EMAILS` = that email (comma separated for more than one), then redeploy.

Supabase checks the password. Only emails listed in `ADMIN_EMAILS` get in, even if someone else has a Supabase account. A login lasts 30 days; "Гарах" signs out. Removing an email from `ADMIN_EMAILS` (and redeploying) ends its sessions.

Environment variables:

| Variable | Example | Notes |
|---|---|---|
| `PRICE_BASIC` | `50,000₮` | Price of the 10-player plan. Default `50,000₮` (or the old `PRICE`) |
| `PRICE_UNLIMITED` | `150,000₮` | Price of the unlimited plan. Default `150,000₮` |
| `BASIC_PLAYER_LIMIT` | `10` | Players allowed on the trial and basic plan. Default `10` |
| `TRIAL_DAYS` | `7` | Length of the free trial. `0` turns it off. Default `7` |
| `PAYMENT_INFO` | `Хаан банк 5000123456 (Бат)` | Shown to customers who haven't paid. Use `\n` for a new line. |
| `ADMIN_EMAILS` | `you@mail.mn` | Who can log in to the admin page with a password (needs Supabase) |

The news sources are fetched once for everyone, and each user is checked against their own list. ESPN player feeds are fetched for up to 200 different players across all users.

## Storage (Supabase)

Customer data lives in a free Supabase (Postgres) project:

| Table | Contents |
|---|---|
| `users` | Customers: Telegram chat id, name, @username, status, request/activation/expiry dates, your note |
| `players` | One row per user (you included): the player list as JSON |
| `follows` | One row per user: followed Bluesky accounts as JSON |
| `users_overview` (view) | Each customer with their player and follow counts |

The bot's own state (which news was already seen and sent, source health, the NBA roster cache) stays in Netlify Blobs. It is read and rewritten every 2 minutes, which would use up Supabase's free egress.

Setup:
1. Create a project at [supabase.com](https://supabase.com) (free plan).
2. Open **SQL Editor**, paste [supabase/schema.sql](supabase/schema.sql), and run it. A database made before plans existed needs [supabase/2026-11-plans.sql](supabase/2026-11-plans.sql) once, **before** deploying the plans version.
3. In **Project Settings → API Keys**, copy the Project URL and a **secret** key (`sb_secret_…`, or the legacy `service_role` key). Never use the publishable/anon key. The tables have row-level security with no policies, so only the secret key can read them.
4. In Netlify, add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (mark it secret), then trigger a deploy.

On its first run after that, the bot copies users, player lists and follows from Netlify Blobs to Supabase once. It never overwrites rows Supabase already has. The old copies stay in Blobs but are no longer read. Without these two variables, everything stays in Netlify Blobs as before.

## Getting tweets

- **Paid X API:** set `sources.twitter.enabled: true` and `bearer_token`, and edit `accounts`. Polling is throttled by `interval_seconds` (default 300) to save quota.
- **Free route:** create an RSS feed of a reporter's X timeline with rss.app or a self-hosted RSSHub, then add it:
  ```json
  "extra_rss": {"feeds": [{"name": "X @ShamsCharania", "url": "https://rss.app/feeds/XXXX.xml"}]}
  ```

## Matching

Names are matched case-insensitively and without accents ("Jokić" matches "Jokic"), as whole words, and with or without Jr./Sr./II/III. Add `aliases` for nicknames, e.g. `{"name": "Shai Gilgeous-Alexander", "aliases": ["SGA"]}`.
Only matching on a last name is not supported on purpose, because it would trigger on every "Jackson" or "Williams".
