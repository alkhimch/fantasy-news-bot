# Deploy for $0 on GitHub Actions with Claude in Chrome

GitHub runs the bot about every 5–15 minutes. It needs no server, no card and no new account.

**Do these 2 things on your phone first (1 minute):**
1. In Telegram, open **your bot** and press **Start** (or send `/start`). The bot can't message you until you do this.
2. In Telegram, message **@userinfobot**. It replies with your **Id** (a number), which is your chat ID. Keep it for later.

Then copy everything in the block below into Claude in Chrome.

```text
You are helping me set up my Telegram news bot to run for free on GitHub Actions.
The repository is https://github.com/alkhimch/fantasy-news-bot . It already contains the workflow file
.github/workflows/news.yml . Work step by step in the browser. After each part, tell me in one line what
you did and what's next.

HARD RULES
- Never type passwords, 2FA codes, or my Telegram bot token. When one is needed, STOP, tell me exactly
  where to click and what to paste, and wait until I say "done".
- Don't change any file in the repo except the one line named in PART 1 option B.
- Don't delete anything. Don't change settings other than the ones listed here.
- If a page looks different from what I describe, find the equivalent option. If unsure, ask me.

PART 1 - Choose public or private (ask me first)
1. Ask me: "Make the repo public (alerts every ~5 min, unlimited free minutes) or keep it private
   (alerts every ~30 min, to stay inside the 2,000 free minutes per month)?" Wait for my answer.
   A) PUBLIC: open https://github.com/alkhimch/fantasy-news-bot/settings , scroll to "Danger Zone",
      click "Change visibility" -> "Change to public" and confirm every prompt. If GitHub asks for my
      password or 2FA, STOP and let me do it. (This is safe: the repo has no secrets; the token goes into
      encrypted Secrets in PART 2.)
   B) PRIVATE: open https://github.com/alkhimch/fantasy-news-bot/edit/main/.github/workflows/news.yml ,
      change ONLY the line   - cron: "*/5 * * * *"   so the value is   "*/30 * * * *"  and leave the
      rest of that line unchanged. Click "Commit changes...", choose "Commit directly to the main
      branch", then click "Commit changes".

PART 2 - Secrets and variables
2. Open https://github.com/alkhimch/fantasy-news-bot/settings/secrets/actions
3. Click "New repository secret":
   - Name: TELEGRAM_BOT_TOKEN
   - Secret: STOP HERE. Tell me: "Paste your bot token from @BotFather into the Secret box and click
     Add secret." Wait for "done".
4. Click "New repository secret" again:
   - Name: TELEGRAM_CHAT_ID
   - Secret: ask me for my chat id (the number from @userinfobot) and type exactly that number.
   - Click "Add secret".
5. Open https://github.com/alkhimch/fantasy-news-bot/settings/variables/actions
   Click "New repository variable":
   - Name: PLAYERS
   - Value: ask me for my players as a comma-separated list (e.g. Nikola Jokic, Victor Wembanyama) and
     type exactly what I say.
   - Click "Add variable".
6. Confirm the Secrets page lists TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, and the Variables page lists
   PLAYERS.

PART 3 - Let the workflow save its memory
7. Open https://github.com/alkhimch/fantasy-news-bot/settings/actions
   - Under "Actions permissions": "Allow all actions and reusable workflows" must be selected.
   - Scroll to "Workflow permissions": select "Read and write permissions" and click Save.

PART 4 - Test runs
8. Open https://github.com/alkhimch/fantasy-news-bot/actions . If there's a green button like
   "I understand my workflows, go ahead and enable them", click it.
9. Click the workflow "fantasy-news" in the left list, then "Run workflow" (right side). In "mode",
   choose test-message, then click the green "Run workflow" button.
   Wait about 30-60 seconds and refresh until the run shows a green check or a red X.
   Ask me: "Did you get '✅ Fantasy news bot is connected.' in Telegram?"
   - If the run is red: open it, click the "poll" job, expand the failing step, and show me the
     error text. Stop.
10. Run the workflow again with mode = test-alerts. When it finishes, open the run -> "poll" ->
    expand "Run bot" and report to me each line that starts with rotowire / espn_fantasy / espn_news
    (each says "ok ..." or "ERROR ..."), and any "-> sending:" lines.
11. Run the workflow once more with mode = once (normal mode). It should finish green. The first normal
    run only records news that is already out and sends nothing. That is expected.
12. Open https://github.com/alkhimch/fantasy-news-bot/branches and confirm a branch named "state" now
    exists.

FINAL REPORT
Summarize: public or private, which secrets and variables exist, the result of each test run, the
source ok/ERROR lines, and that the "state" branch exists. Remind me:
- The bot now runs automatically on the schedule. GitHub may delay scheduled runs by 5-15 minutes.
- Manage players from Telegram with /add Name, /remove Name, /list (answered on the next run).
- To see runs: https://github.com/alkhimch/fantasy-news-bot/actions
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Run fails at **Save state** with a `403` error | Settings → Actions → General → Workflow permissions → **Read and write** |
| `test-message` fails with `chat not found` | Open your bot in Telegram and press **Start**, then check the TELEGRAM_CHAT_ID secret |
| `test-message` fails with `Unauthorized` | The token is wrong. Update the TELEGRAM_BOT_TOKEN secret with the token from @BotFather |
| One source shows `ERROR` | The other sources still work. To turn that source off, set `"enabled": false` for it in `config.example.json` (the GitHub version reads its source settings from that file) |
| No alerts for hours | That's normal if there's no news. Run with mode `test-alerts` to confirm everything works |
| Scheduled runs stopped (public repo) | GitHub pauses schedules after 60 days with no repo activity. The bot's state saves usually count as activity. If runs stop, open Actions → fantasy-news → **Enable workflow** |
