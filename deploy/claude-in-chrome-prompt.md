# Deploy to Netlify ($0) with Claude in Chrome

Netlify runs the bot every 2 minutes, and Telegram commands get answered instantly.
You need: your GitHub login, your Telegram bot token (from @BotFather), your chat ID (from @userinfobot),
and your player list.

Copy everything in the block below into Claude in Chrome.

```text
You are helping me deploy my Telegram news bot to Netlify on the free plan. The code is in the GitHub
repo https://github.com/alkhimch/fantasy-news-bot (branch main). It already contains netlify.toml,
package.json and netlify/functions/ (a scheduled function "poll" and a webhook function "telegram").
Work step by step in the browser. After each part, tell me in one line what you did and what's next.

HARD RULES
- Never type passwords, 2FA codes, credit-card details, or my Telegram bot token. When one is needed,
  STOP, tell me exactly where to click and what to paste, and wait until I say "done".
- Stay on the free plan. Don't buy, upgrade or add-on anything. Don't change any file in the repo.
- If a page looks different from what I describe, find the equivalent option. If unsure, ask me.

PART 1 - Netlify account
1. Open https://app.netlify.com/signup . Choose "Sign up with GitHub". If GitHub asks me to sign in or
   authorize Netlify, STOP and let me do it. Wait for "done".
   (If I'm already logged in to Netlify, skip to PART 2.)
2. If Netlify asks onboarding questions (team name, what I'm building), pick the simplest/free answers
   or "Skip".

PART 2 - Import the repo
3. Open https://app.netlify.com/start (or "Add new project" -> "Import an existing project").
4. Choose "GitHub". If a GitHub window asks to install/authorize the Netlify app:
   - choose my account "alkhimch"
   - "Only select repositories" -> select "fantasy-news-bot" -> Install / Save
   If GitHub asks for my password or 2FA, STOP and let me do it.
5. Pick the repo "alkhimch/fantasy-news-bot".
6. On the settings page, check the values came from netlify.toml. Leave them as they are:
   - Branch to deploy: main
   - Base directory: (empty)
   - Build command: echo no build
   - Publish directory: public
   - Functions directory: netlify/functions
7. Find "Add environment variables" on that page (it may be under "Advanced" or a button). Add:
   - Key TELEGRAM_CHAT_ID: ask me for my chat id number and type exactly that.
   - Key PLAYERS: ask me for my players as a comma-separated list, e.g.
     Nikola Jokic, Victor Wembanyama, Shai Gilgeous-Alexander (SGA)
     Type exactly what I say.
   - Key TELEGRAM_BOT_TOKEN: STOP. Tell me: "Add a variable named TELEGRAM_BOT_TOKEN and paste your
     bot token as its value." Wait for "done". If there is a "Contains secret values" checkbox, tell me to
     tick it for this one.
   If this page has no environment-variable option, deploy first and do step 7 in PART 3 instead.
8. Click "Deploy" (or "Deploy fantasy-news-bot"). Wait until the deploy shows "Published" (1-3 min).
   If it shows "Failed", open the deploy log, scroll to the first red error, and show it to me. Stop.

PART 3 - Check environment variables
9. Open the project -> "Project configuration" (or "Site configuration") -> "Environment variables".
   Confirm TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and PLAYERS all exist. If you had to add any of them now
   (same rules as step 7), go to "Deploys" -> "Trigger deploy" -> "Deploy project/site" and wait for
   "Published". Functions only see variables after a new deploy.

PART 4 - Verify
10. Note the project's URL (like https://something.netlify.app). Open <that URL>/telegram in a new tab.
    It should say: "Fantasy news bot webhook is up." Tell me the URL.
11. In the project, open "Logs & metrics" -> "Functions" (or "Functions" in the left menu).
    Confirm two functions exist: "poll" (marked Scheduled, runs every 2 minutes) and "telegram".
12. Wait about 3 minutes, then open the "poll" function logs. Look for a line "webhook set to ..." and a
    line "poll done { sent: 0, players: N }". The first run sends nothing, which is expected.
    Report these lines to me, or any error lines.
13. Tell me to send /status to my bot in Telegram. The reply should arrive within seconds. Then tell me
    to send /test. I should get a "Source check" message and up to 3 "🧪 TEST" alerts.
    Ask me what I received.

FINAL REPORT
Summarize: the project URL, that both functions exist, the poll log lines, and my Telegram test results.
Remind me:
- Pick players on the website: the bot sends a private link in Telegram (or send /web to get it again)
- Or manage players in Telegram: /add Name, /add Name (Nickname), /remove Name, /list, /status, /test
- Check free-plan usage once after a day: Netlify -> Team -> Usage / Billing.
- New code pushed to GitHub main deploys automatically.
```

## Troubleshooting

| Problem | Fix |
|---|---|
| The deploy fails with "secrets scanning" | Add an environment variable `SECRETS_SCAN_OMIT_KEYS` = `PLAYERS,TELEGRAM_CHAT_ID`, then redeploy |
| `/status` gets no reply | Wait 2–4 minutes after the first deploy, because the first `poll` run sets up the webhook. Check the poll logs for `setWebhook failed`. A `401` there means the token is wrong. |
| `/status` reply says a source has an `ERROR` | The other sources still work. To turn that one off, add the variable `DISABLE_SOURCES` = `espn_news` (comma separated for more than one), then redeploy |
| Alerts arrive but `/add` gets no reply | Check that `TELEGRAM_CHAT_ID` is exactly your number from @userinfobot |
| The usage page shows you're close to the free limit | In `netlify/functions/poll.mjs`, change `*/2` to `*/5` and push |
| You want tweets | Make an RSS feed of the reporter's X account (for example with rss.app), then add the variable `EXTRA_RSS` = `X Shams\|https://rss.app/feeds/XXXX.xml` |

GitHub Actions is now only a manual fallback (its schedule is turned off). Don't run both, or you'll get duplicate alerts.
