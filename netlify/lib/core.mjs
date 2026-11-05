// Fantasy news -> Telegram, Netlify edition. Pure logic; I/O is injected so it can be tested.
// deps: { fetch, store (Netlify Blobs-like: get(key,{type:"json"}), setJSON(key,val)), env, now }
import { createHash } from "node:crypto";

// NOTE: ESPN answers 403 to any User-Agent containing "bot".
const UA = "Mozilla/5.0 (X11; Linux x86_64) fantasy-news/1.0";
const MAX_SEEN = 5000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_ALERTS_PER_RUN = 20;
const FETCH_TIMEOUT_MS = 8000;

// ------------------------------------------------------------------ text utils
export function normalize(s) {
  return (s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
export const stripSuffix = (n) => normalize(n).replace(/ (jr|sr|ii|iii|iv)$/, "");

export function decodeEntities(s) {
  return (s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
export function stripHtml(s) {
  let t = (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = decodeEntities(t).replace(/<[^>]+>/g, " ");
  return decodeEntities(t).replace(/\s+/g, " ").trim();
}
export const escapeHtml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// --------------------------------------------------------------------- players
// "Shai Gilgeous-Alexander (SGA/Shai)" -> {name, aliases:["SGA","Shai"]}
export function parsePlayer(raw) {
  const m = String(raw).trim().match(/^(.*?)\s*(?:\((.*)\))?$/);
  const name = (m[1] || "").trim();
  const aliases = (m[2] || "").split(/[\/|]/).map((a) => a.trim()).filter(Boolean);
  return name ? { name, aliases } : null;
}
export const parsePlayerList = (s) =>
  (s || "").split(",").map(parsePlayer).filter(Boolean);

export function findPlayer(players, name) {
  const n = stripSuffix(name);
  return players.find((p) => stripSuffix(p.name) === n || p.aliases.some((a) => normalize(a) === n));
}

export function matchPlayers(players, text) {
  const t = " " + normalize(text) + " ";
  return players
    .filter((p) => [stripSuffix(p.name), ...p.aliases.map(normalize)].some((k) => k && t.includes(" " + k + " ")))
    .map((p) => p.name);
}

// --------------------------------------------------------------------- sources
async function get(fetch, url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export function parseRss(xml, source) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || [];
  const tag = (b, name) => {
    const m = b.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
  };
  return blocks.map((b) => {
    const strip = (t) => stripHtml(t).replace(/\s*Visit RotoWire\.com for more analysis on this update\.?\s*$/i, "");
    let link = decodeEntities(tag(b, "link"));
    if (!link) { const m = b.match(/<link\b[^>]*href="([^"]+)"/); link = m ? decodeEntities(m[1]) : ""; }
    const title = stripHtml(tag(b, "title"));
    return {
      id: tag(b, "guid") || tag(b, "id") || link || title,
      source,
      title,
      body: strip(tag(b, "description") || tag(b, "summary") || tag(b, "content")),
      get dedupeTexts() { return [this.title, this.body]; },
      url: link,
      published: parseDate(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated")),
      names: [],
    };
  });
}

// ESPN types that are noise for alerts: videos, and game recaps/previews that mention many players.
const ESPN_SKIP_TYPES = new Set(["Media", "Recap", "Preview"]);

function espnItems(list, source) {
  return (list || []).filter((a) => !ESPN_SKIP_TYPES.has(a.type)).map((a) => {
    const names = [];
    const ids = [];
    for (const ath of a.athletes || []) {
      const n = ath.fullName || ath.displayName || ath.description;
      if (n) names.push(n);
      if (ath.id != null) ids.push(String(ath.id));
    }
    for (const c of a.categories || []) {
      if (c.type === "athlete") {
        const n = c.description || c.athlete?.description;
        if (n) names.push(n);
        const id = c.athleteId ?? c.athlete?.id;
        if (id != null) ids.push(String(id));
      }
    }
    return {
      id: String(a.id ?? a.headline),
      source,
      title: a.headline || "",
      body: stripHtml(a.story || a.description || ""),
      url: a.links?.web?.href || "",
      published: parseDate(a.published || a.lastModified),
      names,
      ids,
    };
  });
}

// Per-player ESPN fantasy feed: ~10 latest Rotowire blurbs + stories for one player.
// Rotowire's own RSS only holds the newest 5 items league-wide, so this is the reliable source.
const MAX_PLAYER_FEEDS = 60;
async function espnPlayerFeeds(fetch, players) {
  const tracked = players.filter((p) => p.espnId).slice(0, MAX_PLAYER_FEEDS);
  if (!tracked.length) return [];
  const results = await Promise.allSettled(tracked.map((p) =>
    get(fetch, `https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players?limit=10&playerId=${p.espnId}`)
      .then((x) => ({ p, feed: JSON.parse(x).feed || [] }))));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  return ok.flatMap(({ p, feed }) => feed.filter((a) => !ESPN_SKIP_TYPES.has(a.type)).map((a) => ({
    id: String(a.id ?? a.headline),
    source: a.type === "Rotowire" ? "Rotowire (ESPN)" : "ESPN",
    title: stripHtml(a.headline || ""),
    body: stripHtml(a.story || (a.description !== a.headline ? a.description : "") || ""),
    dedupeTexts: [a.headline || ""],
    url: a.links?.web?.href || `https://www.espn.com/nba/player/_/id/${p.espnId}`,
    published: parseDate(a.published || a.lastModified),
    names: [p.name],
    ids: [p.espnId],
  })));
}

// ------------------------------------------------------------------ bluesky
const BSKY = "https://public.api.bsky.app/xrpc";
export const DEFAULT_FOLLOWS = ["shamsbot.bsky.social", "thesteinline.bsky.social"];
export const MAX_FOLLOWS = 20;

// "@shamsbot", "shamsbot.bsky.social", "https://bsky.app/profile/x.bsky.social" -> "x.bsky.social"
export function normalizeHandle(input) {
  let h = String(input || "").trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?bsky\.app\/profile\//, "").replace(/[/?#].*$/, "").replace(/^@/, "");
  if (!h) return "";
  if (!h.startsWith("did:") && !h.includes(".")) h += ".bsky.social";
  return /^(did:[a-z0-9:._-]+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})$/.test(h) ? h : "";
}

const bskyFeedUrl = (actor, limit) =>
  `${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=${limit}&filter=posts_no_replies`;

export async function resolveBsky(fetch, input) {
  const h = normalizeHandle(input);
  if (!h) throw new Error(`"${input}" is not a Bluesky handle`);
  let p;
  try { p = JSON.parse(await get(fetch, `${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(h)}`)); }
  catch { throw new Error(`Bluesky account not found: ${h}`); }
  if (!p?.did) throw new Error(`Bluesky account not found: ${h}`);
  let lastPostAt = null;
  try {
    const f = JSON.parse(await get(fetch, bskyFeedUrl(p.did, 5)));
    lastPostAt = (f.feed || []).filter((x) => !x.reason).map((x) => x.post?.record?.createdAt).filter(Boolean).sort().pop() || null;
  } catch { /* profile exists; activity unknown */ }
  return { handle: p.handle, did: p.did, name: p.displayName || "", lastPostAt };
}

export async function loadFollows(store, env) {
  let follows = await store.get("follows", { type: "json" });
  if (!follows) {
    const seed = env.FOLLOWS != null ? env.FOLLOWS.split(",") : DEFAULT_FOLLOWS;
    follows = seed.map(normalizeHandle).filter(Boolean).map((handle) => ({ handle, mode: "players" }));
    await store.setJSON("follows", follows);
  }
  return follows;
}

async function blueskyFeeds(fetch, follows) {
  if (!follows.length) return Object.assign([], { seedKeys: [] });
  const results = await Promise.allSettled(follows.map((fo) =>
    get(fetch, bskyFeedUrl(fo.did || fo.handle, 30)).then((x) => ({ fo, feed: JSON.parse(x).feed || [] }))));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  const items = ok.flatMap(({ fo, feed }) => feed.filter((x) => !x.reason && x.post).map(({ post }) => {
    const text = post.record?.text || "";
    const ext = post.embed?.external || post.embed?.media?.external;
    const handle = post.author?.handle || fo.handle;
    return {
      id: post.uri,
      source: `Bluesky @${handle.replace(/\.bsky\.social$/, "")}`,
      title: "",
      body: [text, ext?.title].filter(Boolean).join("\n"),
      dedupeTexts: [text.split("\n")[0]],
      url: `https://bsky.app/profile/${handle}/post/${post.uri.split("/").pop()}`,
      published: parseDate(post.record?.createdAt || post.indexedAt),
      names: [], ids: [],
      seedKey: "bsky:" + fo.handle,
      followAll: fo.mode === "all",
    };
  }));
  items.seedKeys = ok.map(({ fo }) => "bsky:" + fo.handle);
  return items;
}

export function sourceList(env, players = [], follows = []) {
  const disabled = new Set((env.DISABLE_SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean));
  const all = [
    // Rotowire RSS first: its items carry both wordings of a blurb (title line + news sentence),
    // so the ESPN copy (sentence) and the RotoWire Bluesky post (title line) dedupe against it.
    ["rotowire", (f) => get(f, "https://www.rotowire.com/rss/news.php?sport=NBA").then((x) => parseRss(x, "Rotowire"))],
    ["espn_player", (f) => espnPlayerFeeds(f, players)],
    ["bluesky", (f) => blueskyFeeds(f, follows)],
    ["espn_news", (f) => get(f, "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=100")
      .then((x) => espnItems(JSON.parse(x).articles, "ESPN"))],
  ];
  // EXTRA_RSS = "Name|https://url, https://url2"  (e.g. rss.app feeds of reporters' X accounts)
  for (const [i, entry] of (env.EXTRA_RSS || "").split(",").map((s) => s.trim()).filter(Boolean).entries()) {
    const [name, url] = entry.includes("|") ? entry.split("|", 2) : [new URL(entry).hostname, entry];
    all.push([`extra_${i + 1}`, (f) => get(f, url.trim()).then((x) => parseRss(x, name.trim()))]);
  }
  return all.filter(([n]) => !disabled.has(n));
}

async function fetchAll(fetch, env, players, follows = []) {
  const list = sourceList(env, players, follows);
  const results = await Promise.allSettled(list.map(([, fn]) => fn(fetch)));
  return list.map(([name], i) => ({ name, ...results[i] }));
}

// -------------------------------------------------------------------- telegram
export async function tg(fetch, env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}
export const send = (fetch, env, text) =>
  tg(fetch, env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true,
  });

export const webKey = (env) => sha1("fnb-web:" + env.TELEGRAM_BOT_TOKEN).slice(0, 24);
export const webLink = (siteUrl, env) => `${siteUrl}/?key=${webKey(env)}`;

export const webhookSecret = (env) => sha1("fnb-webhook:" + env.TELEGRAM_BOT_TOKEN).slice(0, 32);

export function formatItem(item, hits) {
  const lines = [hits.length
    ? `🏀 <b>${escapeHtml(hits.join(", "))}</b>  ·  <i>${escapeHtml(item.source)}</i>`
    : `📣 <i>${escapeHtml(item.source)}</i>`];
  if (item.title) lines.push(`<b>${escapeHtml(item.title)}</b>`);
  let body = item.body || "";
  if (body.length > 900) body = body.slice(0, 900).replace(/\s+\S*$/, "") + "…";
  if (body) lines.push(escapeHtml(body));
  if (item.published) lines.push(`<i>${item.published.toISOString().slice(0, 16).replace("T", " ")} UTC</i>`);
  if (item.url) lines.push(`<a href="${escapeHtml(item.url)}">Open</a>`);
  return lines.join("\n");
}

// first ~60 normalized chars of the news sentence; identical across Rotowire RSS and ESPN's copy
export function contentKeys(item) {
  return (item.dedupeTexts || [item.dedupeText]).map((x) => normalize(x || ""))
    .filter((t) => t.length >= 25).map((t) => sha1(t.slice(0, 60)));
}
export const contentKey = (item) => contentKeys(item)[0] || null;

function hitsFor(players, item) {
  const ids = new Set(item.ids || []);
  const hits = [...players.filter((p) => p.espnId && ids.has(p.espnId)).map((p) => p.name),
                ...item.names.flatMap((n) => matchPlayers(players, n)),
                ...matchPlayers(players, item.title + " " + item.body)];
  return [...new Set(hits)];
}

// ----------------------------------------------------------------------- state
export async function loadPlayers(store, env) {
  let players = await store.get("players", { type: "json" });
  if (!players) {
    players = parsePlayerList(env.PLAYERS);
    await store.setJSON("players", players);
  }
  return players;
}
const loadState = async (store) =>
  (await store.get("state", { type: "json" })) || { seen: [], status: {}, initialized: false };

// ------------------------------------------------------------------------ poll
export async function runPoll({ fetch, store, env, now = Date.now(), siteUrl, log = console }) {
  const state = await loadState(store);

  // register Telegram webhook (for instant /commands) once per site URL
  if (siteUrl && state.webhookUrl !== siteUrl + "/telegram") {
    try {
      await tg(fetch, env, "setWebhook", {
        url: siteUrl + "/telegram", secret_token: webhookSecret(env), allowed_updates: ["message"],
      });
      state.webhookUrl = siteUrl + "/telegram";
      log.log("webhook set to", state.webhookUrl);
    } catch (e) { log.warn("setWebhook failed:", e.message); }
  }

  if (siteUrl && state.webLinkSentFor !== siteUrl) {
    try {
      await send(fetch, env, `⚙️ Тоглогчоо вебээр сонгох:\n${escapeHtml(webLink(siteUrl, env))}\n(Энэ линкийг хэнд ч бүү өг. Дахин авах: /web)`);
      state.webLinkSentFor = siteUrl;
    } catch (e) { log.warn("web link send failed:", e.message); }
  }

  const players = await loadPlayers(store, env);
  const follows = await loadFollows(store, env);
  await enrichPlayers({ fetch, store, players, now, log });
  state.seeded = state.seeded || [];
  const seededAtStart = new Set(state.seeded);
  const seen = new Set(state.seen);
  state.sentContent = state.sentContent || [];
  const sentContent = new Set(state.sentContent);
  const stamp = new Date(now).toISOString().slice(11, 16) + " UTC";
  const outbox = [];

  if (players.length || follows.some((f) => f.mode === "all")) {
    for (const r of await fetchAll(fetch, env, players, follows)) {
      if (r.status === "rejected") {
        state.status[r.name] = `ERROR ${String(r.reason?.message || r.reason).slice(0, 100)} @ ${stamp}`;
        (state.sourceStatus ||= {})[r.name] = { ok: false, error: String(r.reason?.message || r.reason).slice(0, 100), at: new Date(now).toISOString() };
        log.warn(r.name, "failed:", r.reason?.message);
        continue;
      }
      state.status[r.name] = `ok ${r.value.length} items @ ${stamp}`;
      (state.sourceStatus ||= {})[r.name] = { ok: true, items: r.value.length, at: new Date(now).toISOString() };
      for (const item of [...r.value].reverse()) { // oldest first
        const key = sha1(item.source.split(" ")[0] + "|" + item.id);
        if (seen.has(key)) continue;
        seen.add(key); state.seen.push(key);
        if (!state.initialized) continue; // first run: just learn existing news
        if (item.seedKey && !seededAtStart.has(item.seedKey)) continue; // newly followed account: skip its old posts
        if (item.published && now - item.published.getTime() > MAX_AGE_MS) continue;
        const hits = hitsFor(players, item);
        if (!hits.length && !item.followAll) continue;
        const keys = contentKeys(item);
        const dup = keys.some((k) => sentContent.has(k)); // same blurb already sent via another source
        for (const k of keys) if (!sentContent.has(k)) { sentContent.add(k); state.sentContent.push(k); }
        if (!dup) outbox.push(formatItem(item, hits));
      }
      for (const k of r.value.seedKeys || []) if (!state.seeded.includes(k)) state.seeded.push(k);
    }
    state.initialized = true;
  }

  let sent = 0;
  for (const msg of outbox.slice(0, MAX_ALERTS_PER_RUN)) {
    try { await send(fetch, env, msg); sent++; } catch (e) { log.error("send failed:", e.message); }
  }
  if (outbox.length > MAX_ALERTS_PER_RUN) {
    await send(fetch, env, `…and ${outbox.length - MAX_ALERTS_PER_RUN} more updates.`).catch(() => {});
  }
  if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
  if (state.sentContent.length > 1000) state.sentContent = state.sentContent.slice(-1000);
  state.lastRun = new Date(now).toISOString();
  await store.setJSON("state", state);
  return { sent, players: players.length };
}

// ------------------------------------------------------------- test (/test)
export async function runTestAlerts({ fetch, store, env, limit = 3 }) {
  const players = await loadPlayers(store, env);
  const follows = await loadFollows(store, env);
  const lines = [];
  const found = [];
  for (const r of await fetchAll(fetch, env, players, follows)) {
    if (r.status === "rejected") { lines.push(`${r.name}: ERROR ${r.reason?.message}`); continue; }
    const m = r.value.map((i) => [i, hitsFor(players, i)]).filter(([, h]) => h.length);
    lines.push(`${r.name}: ok, ${r.value.length} items, ${m.length} about your players`);
    found.push(...m);
  }
  await send(fetch, env, "🧪 Source check\n" + escapeHtml(lines.join("\n")));
  const keysSeen = new Set();
  const unique = found.filter(([item]) => {
    const keys = contentKeys(item);
    const dup = keys.some((k) => keysSeen.has(k));
    keys.forEach((k) => keysSeen.add(k));
    return !dup;
  });
  found.length = 0; found.push(...unique);
  found.sort((a, b) => (b[0].published?.getTime() || 0) - (a[0].published?.getTime() || 0));
  if (!found.length) {
    await send(fetch, env, "No current news mentions your players. Try /add a player who is in today's news.");
  }
  for (const [item, hits] of found.slice(0, limit)) await send(fetch, env, "🧪 TEST\n" + formatItem(item, hits));
  return lines;
}

// -------------------------------------------------------------- commands
const HELP =
  "/list – tracked players\n/add Name[, Name2] – track (aliases: Name (Nick))\n" +
  "/remove Name – untrack\n/web – link to pick players on the website\n/sources – all news sources and their health\n" +
  "/follow handle [all] – follow a Bluesky account (posts about your players; 'all' = every post)\n" +
  "/unfollow handle – stop following\n/following – followed accounts\n" +
  "/status – source health\n/test – check sources + send sample alerts";

export async function handleUpdate({ update, fetch, store, env }) {
  // Telegram retries if we're slow; process each update_id only once.
  const tgState = (await store.get("tg", { type: "json" })) || { lastUpdateId: 0 };
  if (update.update_id <= tgState.lastUpdateId) return "duplicate";
  await store.setJSON("tg", { lastUpdateId: update.update_id });

  const msg = update.message || {};
  if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return "ignored"; // owner only
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return "ignored";
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  let players = await loadPlayers(store, env);
  let reply;
  if (cmd === "/add" && arg) {
    const added = [];
    for (const p of parsePlayerList(arg)) if (!findPlayer(players, p.name)) { players.push(p); added.push(p.name); }
    await store.setJSON("players", players);
    reply = added.length ? "Added: " + added.join(", ") : "Already tracked.";
  } else if ((cmd === "/remove" || cmd === "/rm") && arg) {
    const p = findPlayer(players, arg);
    if (p) { players = players.filter((x) => x !== p); await store.setJSON("players", players); }
    reply = p ? `Removed ${p.name}.` : `Not tracked: ${arg}`;
  } else if (cmd === "/list") {
    const names = players.map((p) => p.name + (p.aliases.length ? ` (${p.aliases.join("/")})` : "")).sort();
    reply = names.length ? `Tracking ${names.length} players:\n` + names.map((n) => "• " + n).join("\n") : "No players yet. /add Name";
  } else if (cmd === "/sources") {
    reply = formatSources(await describeSources(store, env));
  } else if (cmd === "/status") {
    const st = await loadState(store);
    reply = Object.entries(st.status).map(([k, v]) => `${k}: ${v}`).join("\n") || "No polls yet.";
    reply += `\nLast run: ${st.lastRun || "never"}`;
  } else if (cmd === "/follow" && arg) {
    reply = await followCommand({ fetch, store, env, arg });
  } else if (cmd === "/unfollow" && arg) {
    const follows = await loadFollows(store, env);
    const h = normalizeHandle(arg);
    const f = follows.find((x) => x.handle === h || x.did === h);
    if (f) await store.setJSON("follows", follows.filter((x) => x !== f));
    reply = f ? `Unfollowed @${f.handle}.` : `Not following: ${arg}`;
  } else if (cmd === "/following" || cmd === "/follow") {
    const follows = await loadFollows(store, env);
    reply = follows.length
      ? "Following on Bluesky:\n" + follows.map((f) => `• @${f.handle}${f.name ? ` (${f.name})` : ""} – ${f.mode === "all" ? "every post" : "your players only"}`).join("\n")
      : "Not following anyone.";
    reply += "\n\nAdd: /follow shamsbot.bsky.social  (add 'all' for every post)";
  } else if (cmd === "/web") {
    const st = await loadState(store);
    const site = (st.webhookUrl || "").replace(/\/telegram$/, "");
    reply = site ? `⚙️ ${webLink(site, env)}` : "Site URL not known yet – wait for the first scheduled run.";
  } else if (cmd === "/test") {
    await runTestAlerts({ fetch, store, env });
    return "test";
  } else {
    reply = HELP;
  }
  await send(fetch, env, escapeHtml(reply));
  return cmd;
}

// ------------------------------------------------------------- roster (web UI)
const TEAMS_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams";
const rosterUrl = (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/roster`;
const ROSTER_MAX_AGE_MS = 12 * 3600 * 1000;

export async function fetchRoster(fetch) {
  let teams = [];
  try {
    const d = JSON.parse(await get(fetch, TEAMS_URL));
    teams = (d.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean)
      .map((t) => ({ id: String(t.id), abbr: t.abbreviation || "", name: t.displayName || t.name || "" }));
  } catch { /* fall back to ESPN's fixed NBA team ids 1..30 */ }
  if (!teams.length) teams = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), abbr: "", name: "" }));

  const results = await Promise.allSettled(teams.map((t) => get(fetch, rosterUrl(t.id)).then(JSON.parse)));
  const players = [];
  const outTeams = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const d = r.value;
    const abbr = teams[i].abbr || d.team?.abbreviation || "";
    outTeams.push({ abbr, name: teams[i].name || d.team?.displayName || abbr });
    let list = d.athletes || [];
    if (list.some((g) => Array.isArray(g.items))) list = list.flatMap((g) => g.items || []); // grouped format
    for (const a of list) {
      const name = a.fullName || a.displayName;
      if (!name) continue;
      players.push({
        id: String(a.id ?? ""), name, team: abbr,
        pos: a.position?.abbreviation || "",
        headshot: a.headshot?.href || "",
        injury: a.injuries?.[0]?.status || "",
      });
    }
  });
  return { players, teams: outTeams, teamCount: teams.length };
}

export async function getRoster({ fetch, store, now = Date.now(), force = false }) {
  const cached = await store.get("roster", { type: "json" });
  if (!force && cached?.players?.length && now - cached.updatedAt < ROSTER_MAX_AGE_MS) return cached;
  const r = await fetchRoster(fetch);
  // accept only a (nearly) complete league; otherwise keep the old copy
  if (r.teams.length < r.teamCount - 5 || r.players.length < 100) {
    if (cached?.players?.length) return cached;
    if (!r.players.length) throw new Error("could not load NBA rosters from ESPN");
  }
  const roster = {
    updatedAt: now,
    players: r.players.sort((a, b) => a.name.localeCompare(b.name)),
    teams: r.teams.sort((a, b) => a.abbr.localeCompare(b.abbr)),
  };
  await store.setJSON("roster", roster);
  return roster;
}

// Give players added by name (Telegram /add, PLAYERS env) their ESPN id + team from the roster.
export async function enrichPlayers({ fetch, store, players, now = Date.now(), log = console }) {
  if (!players.some((p) => !p.espnId)) return false;
  let roster;
  try { roster = await getRoster({ fetch, store, now }); } catch (e) { log.warn("roster unavailable:", e.message); return false; }
  const byKey = new Map(roster.players.map((r) => [stripSuffix(r.name), r]));
  let changed = false;
  for (const p of players) {
    if (p.espnId) continue;
    const r = byKey.get(stripSuffix(p.name)) || roster.players.find((x) => p.aliases.some((a) => stripSuffix(a) === stripSuffix(x.name)));
    if (r?.id) { p.espnId = r.id; p.team = r.team; changed = true; }
  }
  if (changed) await store.setJSON("players", players);
  return changed;
}

// validate a player list coming from the web page
export function sanitizePlayers(list) {
  if (!Array.isArray(list)) throw new Error("players must be an array");
  const out = [];
  for (const p of list.slice(0, 300)) {
    const name = String(p?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name || findPlayer(out, name)) continue;
    const entry = {
      name,
      aliases: (Array.isArray(p.aliases) ? p.aliases : []).map((a) => String(a).trim().slice(0, 40)).filter(Boolean).slice(0, 5),
    };
    if (p.espnId) entry.espnId = String(p.espnId).replace(/\D/g, "").slice(0, 12);
    if (p.team) entry.team = String(p.team).replace(/[^A-Za-z]/g, "").slice(0, 4);
    out.push(entry);
  }
  return out;
}

// /follow <handle> [all]
export async function followCommand({ fetch, store, env, arg, now = Date.now() }) {
  if (/(^|\/\/|\.)(x|twitter)\.com\b/i.test(arg)) {
    return "X/Twitter accounts can't be read for free – only Bluesky accounts work.\nExample: /follow shamsbot.bsky.social";
  }
  const parts = arg.split(/\s+/).filter(Boolean);
  const mode = parts.slice(1).some((p) => p.toLowerCase() === "all") ? "all" : "players";
  const follows = await loadFollows(store, env);
  let info;
  try { info = await resolveBsky(fetch, parts[0]); } catch (e) { return e.message + "\nExample: /follow shamsbot.bsky.social"; }
  const existing = follows.find((f) => f.did === info.did || f.handle === info.handle);
  if (!existing && follows.length >= MAX_FOLLOWS) return `You can follow up to ${MAX_FOLLOWS} accounts. /unfollow one first.`;
  const entry = { handle: info.handle, did: info.did, name: info.name, lastPostAt: info.lastPostAt, mode };
  await store.setJSON("follows", existing ? follows.map((f) => (f === existing ? entry : f)) : [...follows, entry]);
  let msg = `${existing ? "Updated" : "Following"} @${info.handle}${info.name ? ` (${info.name})` : ""} – ` +
    (mode === "all" ? "you'll get every post." : "you'll get posts that mention your players.");
  const ageDays = info.lastPostAt ? (now - Date.parse(info.lastPostAt)) / 864e5 : Infinity;
  if (ageDays > 30) {
    msg += `\n⚠️ Last post: ${info.lastPostAt ? info.lastPostAt.slice(0, 10) : "none"} – this account looks inactive.`;
  }
  return msg;
}

// validate a follow list coming from the web page; resolves new handles via Bluesky
export async function saveFollowsFromWeb({ fetch, store, env, list }) {
  if (!Array.isArray(list)) throw new Error("follows must be an array");
  const current = await loadFollows(store, env);
  const out = [];
  for (const raw of list.slice(0, MAX_FOLLOWS)) {
    const h = normalizeHandle(raw?.handle);
    if (!h) throw new Error(`"${raw?.handle}" is not a Bluesky handle`);
    const mode = raw?.mode === "all" ? "all" : "players";
    let entry = current.find((f) => f.handle === h || f.did === h);
    if (!entry || !entry.did) {
      const info = await resolveBsky(fetch, h);
      entry = { handle: info.handle, did: info.did, name: info.name, lastPostAt: info.lastPostAt };
    }
    if (!out.some((f) => f.did === entry.did)) out.push({ ...entry, mode });
  }
  await store.setJSON("follows", out);
  return out;
}

// ------------------------------------------------------------- /sources
export const SOURCE_INFO = {
  rotowire: { label: "Rotowire RSS", en: "Newest 5 Rotowire blurbs league-wide (backup)",
              mn: "Rotowire-ийн NBA-ийн хамгийн сүүлийн 5 мэдээ (нөөц)" },
  espn_player: { label: "ESPN player feeds", en: "Latest ~10 Rotowire blurbs + ESPN stories for each of your players",
                 mn: "Таны тоглогч бүрийн Rotowire-ийн сүүлийн ~10 мэдээ + ESPN нийтлэл" },
  bluesky: { label: "Bluesky", en: "Posts from the Bluesky accounts you follow",
             mn: "Таны дагасан Bluesky хаягуудын пост" },
  espn_news: { label: "ESPN NBA news", en: "ESPN headline stories (videos, recaps and previews skipped)",
               mn: "ESPN-ий гол нийтлэлүүд (видео, тойм, урьдчилсан тойм алгасна)" },
};

export async function describeSources(store, env) {
  const state = await loadState(store);
  const players = await loadPlayers(store, env);
  const follows = await loadFollows(store, env);
  const enabled = new Set(sourceList(env, players, follows).map(([n]) => n));
  const all = sourceList({ ...env, DISABLE_SOURCES: "" }, players, follows).map(([n]) => n);
  const extra = (env.EXTRA_RSS || "").split(",").map((x) => x.trim()).filter(Boolean);
  return all.map((name) => {
    const info = SOURCE_INFO[name] || { label: name, en: "Extra RSS feed", mn: "Нэмэлт RSS" };
    let detail = null;
    if (name === "espn_player") {
      const linked = players.filter((p) => p.espnId).length;
      const missing = players.filter((p) => !p.espnId).map((p) => p.name);
      detail = { en: `${linked}/${players.length} players linked to ESPN` + (missing.length ? ` (not linked: ${missing.join(", ")})` : ""),
                 mn: `${linked}/${players.length} тоглогч ESPN-тэй холбогдсон` + (missing.length ? ` (холбогдоогүй: ${missing.join(", ")})` : "") };
    } else if (name === "bluesky") {
      const list = follows.map((f) => "@" + f.handle.replace(/\.bsky\.social$/, "") + (f.mode === "all" ? " (all)" : ""));
      detail = { en: list.length ? list.join(", ") : "not following anyone", mn: list.length ? list.join(", ").replace(/\(all\)/g, "(бүх пост)") : "хэнийг ч дагаагүй" };
    } else if (name.startsWith("extra_")) {
      const raw = extra[Number(name.slice(6)) - 1] || "";
      const label = raw.includes("|") ? raw.split("|")[0].trim() : raw.replace(/^https?:\/\//, "").split("/")[0];
      info.label = label || name;
    }
    return { name, label: info.label, en: info.en, mn: info.mn, enabled: enabled.has(name),
             status: state.sourceStatus?.[name] || null, detail };
  });
}

export function formatSources(list) {
  const hhmm = (iso) => iso.slice(11, 16) + " UTC";
  const lines = ["📡 News sources"];
  for (const s of list) {
    let head;
    if (!s.enabled) head = `⏸ ${s.label} – off`;
    else if (!s.status) head = `⏳ ${s.label} – not checked yet`;
    else if (s.status.ok) head = `✅ ${s.label} – ${s.status.items} items @ ${hhmm(s.status.at)}`;
    else head = `❌ ${s.label} – ${s.status.error} @ ${hhmm(s.status.at)}`;
    lines.push("", head, "   " + s.en);
    if (s.detail) lines.push("   " + s.detail.en);
  }
  lines.push("", "Checked every 2 minutes. Manage: /follow, /add, /web");
  return lines.join("\n");
}
