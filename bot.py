#!/usr/bin/env python3
"""
Fantasy news -> Telegram bot.

Polls player-news sources (Rotowire RSS, ESPN, optional X/Twitter API, any extra
RSS feeds) and sends a Telegram message whenever one of your players shows up.

Standard library only (Python 3.8+).

Usage:
  python3 bot.py --get-chat-id     # after messaging your bot once, prints your chat id
  python3 bot.py --once            # one poll cycle, then exit (good for cron)
  python3 bot.py                   # run forever
  python3 bot.py --test-message    # send a test message to Telegram

Telegram commands (send to your bot):
  /list               show tracked players
  /add Name           track a player
  /remove Name        stop tracking a player
  /status             last poll info per source
  /help
"""
import argparse
import email.utils
import hashlib
import html
import json
import logging
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("FNB_CONFIG", os.path.join(BASE_DIR, "config.json"))
DATA_DIR = os.environ.get("FNB_DATA", os.path.join(BASE_DIR, "data"))
STATE_PATH = os.path.join(DATA_DIR, "state.json")
PLAYERS_PATH = os.path.join(DATA_DIR, "players.json")

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) fantasy-news-bot/1.0"
MAX_SEEN = 5000

log = logging.getLogger("fnb")


# --------------------------------------------------------------------------- utils

def http_get(url, headers=None, timeout=20):
    # type: (str, Optional[Dict[str, str]], int) -> bytes
    h = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_json(url, headers=None):
    return json.loads(http_get(url, headers).decode("utf-8"))


def normalize(text):
    # type: (str) -> str
    """lowercase, strip accents/punctuation, collapse spaces: 'Nikola Jokić' -> 'nikola jokic'."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def strip_suffix(name):
    # type: (str) -> str
    return re.sub(r"\s+(jr|sr|ii|iii|iv)$", "", normalize(name))


def strip_html(text):
    # type: (str) -> str
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_date(value):
    # type: (Optional[str]) -> Optional[datetime]
    if not value:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(value)  # RFC 822 (RSS)
    except (TypeError, ValueError, IndexError):
        dt = None
    if dt is None:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


# ------------------------------------------------------------------------ players

class Players:
    """Tracked players, persisted in data/players.json, seeded from config."""

    def __init__(self, seed):
        # type: (List) -> None
        data = load_json(PLAYERS_PATH, None)
        if data is None:
            data = [self._entry(p) for p in seed]
            save_json(PLAYERS_PATH, data)
        self.items = data  # list of {"name": str, "aliases": [str]}

    @staticmethod
    def _entry(p):
        if isinstance(p, str):
            return {"name": p, "aliases": []}
        return {"name": p["name"], "aliases": list(p.get("aliases", []))}

    def save(self):
        save_json(PLAYERS_PATH, self.items)

    def names(self):
        return [p["name"] for p in self.items]

    def add(self, name):
        # type: (str) -> bool
        if self.find(name):
            return False
        self.items.append({"name": name.strip(), "aliases": []})
        self.save()
        return True

    def remove(self, name):
        # type: (str) -> Optional[str]
        p = self.find(name)
        if not p:
            return None
        self.items.remove(p)
        self.save()
        return p["name"]

    def find(self, name):
        n = strip_suffix(name)
        for p in self.items:
            if strip_suffix(p["name"]) == n or n in [normalize(a) for a in p["aliases"]]:
                return p
        return None

    def match(self, text):
        # type: (str) -> List[str]
        """Return names of tracked players mentioned in text (word-boundary match)."""
        t = " " + normalize(text) + " "
        hits = []
        for p in self.items:
            keys = [strip_suffix(p["name"])] + [normalize(a) for a in p["aliases"]]
            if any(k and (" " + k + " ") in t for k in keys):
                hits.append(p["name"])
        return hits


# ------------------------------------------------------------------------ sources
# Every source returns a list of dicts:
#   {id, source, title, body, url, published (datetime|None), names (list of str)}
# `names` = player names the source itself tagged (may be empty); text is also
# name-matched, so untagged items still work.

def src_rotowire(cfg):
    url = cfg.get("url", "https://www.rotowire.com/rss/news.php?sport=NBA")
    return parse_rss(http_get(url), "Rotowire")


def parse_rss(raw, source_name):
    # type: (bytes, str) -> List[dict]
    root = ET.fromstring(raw)
    items = []
    # RSS 2.0 <item> and Atom <entry>
    atom = "{http://www.w3.org/2005/Atom}"
    for it in root.iter():
        tag = it.tag
        if tag not in ("item", atom + "entry"):
            continue

        def txt(name):
            el = it.find(name)
            if el is None:
                el = it.find(atom + name)
            return (el.text or "").strip() if el is not None and el.text else ""

        link = txt("link")
        if not link:
            el = it.find(atom + "link")
            if el is not None:
                link = el.get("href", "")
        title = strip_html(txt("title"))
        body = strip_html(txt("description") or txt("summary") or txt("content"))
        guid = txt("guid") or txt("id") or link or title
        items.append({
            "id": guid,
            "source": source_name,
            "title": title,
            "body": body,
            "url": link,
            "published": parse_date(txt("pubDate") or txt("published") or txt("updated")),
            "names": [],
        })
    return items


def src_espn_news(cfg):
    """ESPN NBA news feed (articles + short news), tagged with athletes."""
    url = cfg.get("url", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=100")
    data = http_get_json(url)
    out = []
    for a in data.get("articles", []):
        names = []
        for c in a.get("categories", []):
            if c.get("type") == "athlete":
                n = c.get("description") or (c.get("athlete") or {}).get("description")
                if n:
                    names.append(n)
        out.append({
            "id": str(a.get("id") or a.get("headline")),
            "source": "ESPN",
            "title": a.get("headline", ""),
            "body": strip_html(a.get("description", "")),
            "url": ((a.get("links") or {}).get("web") or {}).get("href", ""),
            "published": parse_date(a.get("published") or a.get("lastModified")),
            "names": names,
        })
    return out


def src_espn_fantasy(cfg):
    """ESPN fantasy player-news blurbs (the injury/role updates shown in ESPN Fantasy)."""
    url = cfg.get("url", "https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players?limit=100")
    data = http_get_json(url)
    feed = data.get("feed") or data.get("articles") or []
    out = []
    for a in feed:
        names = []
        for ath in a.get("athletes", []) or []:
            n = ath.get("fullName") or ath.get("displayName") or ath.get("description")
            if n:
                names.append(n)
        for c in a.get("categories", []) or []:
            if c.get("type") == "athlete" and c.get("description"):
                names.append(c["description"])
        body = a.get("story") or a.get("description") or ""
        out.append({
            "id": str(a.get("id") or a.get("headline")),
            "source": "ESPN Fantasy",
            "title": a.get("headline", ""),
            "body": strip_html(body),
            "url": ((a.get("links") or {}).get("web") or {}).get("href", ""),
            "published": parse_date(a.get("published") or a.get("lastModified")),
            "names": names,
        })
    return out


def src_twitter(cfg, players):
    # type: (dict, Players) -> List[dict]
    """X API v2 recent search. Needs a paid X API plan (search is not on the free tier)."""
    token = cfg.get("bearer_token")
    if not token or not players.names():
        return []
    accounts = cfg.get("accounts", [])
    prefix = ""
    if accounts:
        prefix = "(" + " OR ".join("from:" + a.lstrip("@") for a in accounts) + ") "
    suffix = " -is:retweet"
    max_len = int(cfg.get("max_query_len", 512))

    # chunk player names so each query fits the length limit
    queries, chunk = [], []
    for name in players.names():
        quoted = '"%s"' % name.replace('"', "")
        trial = prefix + "(" + " OR ".join(chunk + [quoted]) + ")" + suffix
        if chunk and len(trial) > max_len:
            queries.append(prefix + "(" + " OR ".join(chunk) + ")" + suffix)
            chunk = []
        chunk.append(quoted)
    if chunk:
        queries.append(prefix + "(" + " OR ".join(chunk) + ")" + suffix)

    out = []
    for q in queries:
        params = urllib.parse.urlencode({
            "query": q,
            "max_results": 50,
            "tweet.fields": "created_at,author_id",
            "expansions": "author_id",
            "user.fields": "username,name",
        })
        data = http_get_json("https://api.twitter.com/2/tweets/search/recent?" + params,
                             {"Authorization": "Bearer " + token})
        users = {u["id"]: u for u in (data.get("includes") or {}).get("users", [])}
        for t in data.get("data", []) or []:
            u = users.get(t.get("author_id"), {})
            handle = u.get("username", "unknown")
            out.append({
                "id": t["id"],
                "source": "X @" + handle,
                "title": "",
                "body": t.get("text", ""),
                "url": "https://x.com/%s/status/%s" % (handle, t["id"]),
                "published": parse_date(t.get("created_at")),
                "names": [],
            })
    return out


def src_extra_rss(cfg):
    """Any RSS/Atom feeds: e.g. an RSSHub / rss.app feed of a reporter's X account."""
    out = []
    for feed in cfg.get("feeds", []):
        if isinstance(feed, str):
            feed = {"url": feed}
        try:
            out.extend(parse_rss(http_get(feed["url"]), feed.get("name") or urllib.parse.urlparse(feed["url"]).netloc))
        except Exception as e:  # one bad feed shouldn't kill the rest
            log.warning("extra feed %s failed: %s", feed.get("url"), e)
    return out


# ----------------------------------------------------------------------- telegram

class Telegram:
    def __init__(self, token, chat_id):
        self.base = "https://api.telegram.org/bot%s/" % token
        self.chat_id = str(chat_id) if chat_id is not None else None

    def call(self, method, params):
        body = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(self.base + method, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code == 429:  # rate limited: wait and retry once
                retry = json.loads(detail).get("parameters", {}).get("retry_after", 5)
                time.sleep(int(retry) + 1)
                with urllib.request.urlopen(req, timeout=40) as resp:
                    return json.loads(resp.read().decode())
            raise RuntimeError("Telegram %s failed: %s %s" % (method, e.code, detail))

    def send(self, text, chat_id=None):
        return self.call("sendMessage", {
            "chat_id": chat_id or self.chat_id,
            "text": text[:4096],
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        })

    def updates(self, offset, timeout=0):
        return self.call("getUpdates", {"offset": offset, "timeout": timeout}).get("result", [])


def format_item(item, players_hit):
    # type: (dict, List[str]) -> str
    e = html.escape
    lines = ["🏀 <b>%s</b>  ·  <i>%s</i>" % (e(", ".join(players_hit)), e(item["source"]))]
    if item["title"]:
        lines.append("<b>%s</b>" % e(item["title"]))
    body = item["body"]
    if body:
        if len(body) > 900:
            body = body[:900].rsplit(" ", 1)[0] + "…"
        lines.append(e(body))
    if item["published"]:
        lines.append("<i>%s</i>" % item["published"].astimezone().strftime("%b %d, %H:%M"))
    if item["url"]:
        lines.append('<a href="%s">Open</a>' % e(item["url"], quote=True))
    return "\n".join(lines)


# ---------------------------------------------------------------------------- bot

class Bot:
    def __init__(self, cfg):
        self.cfg = cfg
        tg = cfg["telegram"]
        self.tg = Telegram(tg["bot_token"], tg.get("chat_id"))
        self.players = Players(cfg.get("players", []))
        self.state = load_json(STATE_PATH, {"seen": [], "update_offset": 0, "status": {}, "last_poll": {}})
        self.seen = set(self.state["seen"])
        self.max_age = timedelta(hours=float(cfg.get("max_age_hours", 24)))
        self.first_run = not self.state["seen"]

    # --- state
    def save_state(self):
        seen = list(self.seen)
        if len(seen) > MAX_SEEN:
            # keep the most recently added ids (order of self.state["seen"] is append order)
            order = [s for s in self.state["seen"] if s in self.seen]
            seen = order[-MAX_SEEN:]
            self.seen = set(seen)
        self.state["seen"] = seen
        save_json(STATE_PATH, self.state)

    def mark_seen(self, key):
        if key not in self.seen:
            self.seen.add(key)
            self.state["seen"].append(key)

    # --- sources
    def sources(self):
        s = self.cfg.get("sources", {})
        out = []
        if s.get("rotowire", {}).get("enabled", True):
            out.append(("rotowire", lambda c=s.get("rotowire", {}): src_rotowire(c), 0))
        if s.get("espn_fantasy", {}).get("enabled", True):
            out.append(("espn_fantasy", lambda c=s.get("espn_fantasy", {}): src_espn_fantasy(c), 0))
        if s.get("espn_news", {}).get("enabled", True):
            out.append(("espn_news", lambda c=s.get("espn_news", {}): src_espn_news(c), 0))
        tw = s.get("twitter", {})
        if tw.get("enabled") and tw.get("bearer_token"):
            out.append(("twitter", lambda c=tw: src_twitter(c, self.players),
                        int(tw.get("interval_seconds", 300))))
        ex = s.get("extra_rss", {})
        if ex.get("feeds"):
            out.append(("extra_rss", lambda c=ex: src_extra_rss(c), 0))
        return out

    def poll(self):
        if not self.players.items:
            log.info("no players tracked; skipping poll")
            return
        now = datetime.now(timezone.utc)
        sent = 0
        for name, fetch, min_interval in self.sources():
            last = self.state["last_poll"].get(name, 0)
            if min_interval and time.time() - last < min_interval:
                continue
            self.state["last_poll"][name] = time.time()
            try:
                items = fetch()
                self.state["status"][name] = "ok %d items @ %s" % (len(items), now.strftime("%H:%M UTC"))
            except Exception as e:
                log.warning("source %s failed: %s", name, e)
                self.state["status"][name] = "ERROR %s @ %s" % (str(e)[:120], now.strftime("%H:%M UTC"))
                continue

            for item in reversed(items):  # oldest first so Telegram order is chronological
                key = hashlib.sha1((item["source"].split(" ")[0] + "|" + item["id"]).encode()).hexdigest()
                if key in self.seen:
                    continue
                self.mark_seen(key)
                if self.first_run:
                    continue  # first run: just learn what's already out there
                if item["published"] and now - item["published"] > self.max_age:
                    continue
                hits = []
                for n in item["names"]:
                    hits.extend(self.players.match(n))
                hits.extend(self.players.match(item["title"] + " " + item["body"]))
                hits = list(dict.fromkeys(hits))
                if not hits:
                    continue
                try:
                    self.tg.send(format_item(item, hits))
                    sent += 1
                    time.sleep(0.5)
                except Exception as e:
                    log.error("telegram send failed: %s", e)
        if self.first_run:
            log.info("first run: indexed %d existing items, will alert on new ones from now on", len(self.seen))
            self.first_run = False
        if sent:
            log.info("sent %d alerts", sent)
        self.save_state()

    # --- commands
    def handle_commands(self):
        try:
            ups = self.tg.updates(self.state.get("update_offset", 0))
        except Exception as e:
            log.warning("getUpdates failed: %s", e)
            return
        for u in ups:
            self.state["update_offset"] = u["update_id"] + 1
            msg = u.get("message") or {}
            chat = str((msg.get("chat") or {}).get("id", ""))
            text = (msg.get("text") or "").strip()
            if not text.startswith("/") or chat != self.tg.chat_id:
                continue  # only obey the owner chat
            cmd, _, arg = text.partition(" ")
            cmd = cmd.split("@")[0].lower()
            arg = arg.strip()
            if cmd == "/add" and arg:
                added = [n.strip() for n in arg.split(",") if n.strip() and self.players.add(n.strip())]
                reply = "Added: " + ", ".join(added) if added else "Already tracked."
            elif cmd in ("/remove", "/rm") and arg:
                gone = self.players.remove(arg)
                reply = "Removed %s." % gone if gone else "Not tracked: %s" % arg
            elif cmd == "/list":
                names = sorted(self.players.names())
                reply = "Tracking %d players:\n%s" % (len(names), "\n".join("• " + n for n in names)) if names else "No players yet. /add Name"
            elif cmd == "/status":
                st = self.state.get("status", {})
                reply = "\n".join("%s: %s" % kv for kv in st.items()) or "No polls yet."
            else:
                reply = ("/list – tracked players\n/add Name[, Name2] – track\n"
                         "/remove Name – untrack\n/status – source health")
            try:
                self.tg.send(html.escape(reply))
            except Exception as e:
                log.error("reply failed: %s", e)
        if ups:
            self.save_state()

    def run_forever(self):
        interval = int(self.cfg.get("poll_interval_seconds", 120))
        log.info("tracking %d players, polling every %ss", len(self.players.items), interval)
        next_poll = 0.0
        while True:
            if time.time() >= next_poll:
                self.poll()
                next_poll = time.time() + interval
            self.handle_commands()
            time.sleep(5)


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Fantasy player news -> Telegram")
    ap.add_argument("--once", action="store_true", help="poll once and exit")
    ap.add_argument("--get-chat-id", action="store_true", help="print chat ids that messaged the bot")
    ap.add_argument("--test-message", action="store_true", help="send a test message")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_json(CONFIG_PATH, None)
    if cfg is None:
        sys.exit("No config at %s. Copy config.example.json to config.json and fill it in." % CONFIG_PATH)

    tg = Telegram(cfg["telegram"]["bot_token"], cfg["telegram"].get("chat_id"))
    if args.get_chat_id:
        ups = tg.updates(0)
        chats = {str(u["message"]["chat"]["id"]): u["message"]["chat"].get("username") or u["message"]["chat"].get("title")
                 for u in ups if "message" in u}
        if not chats:
            print("No messages yet. Open your bot in Telegram, send it /start, then rerun.")
        for cid, who in chats.items():
            print("chat_id=%s  (%s)" % (cid, who))
        return
    if not cfg["telegram"].get("chat_id"):
        sys.exit("Set telegram.chat_id in config.json (use --get-chat-id).")
    if args.test_message:
        tg.send("✅ Fantasy news bot is connected.")
        print("sent")
        return

    bot = Bot(cfg)
    if args.once:
        bot.handle_commands()
        bot.poll()
    else:
        bot.run_forever()


if __name__ == "__main__":
    main()
