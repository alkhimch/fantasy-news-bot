// Fantasy news -> Telegram, Netlify edition. Pure logic; I/O is injected so it can be tested.
// deps: { fetch, store (Netlify Blobs-like: get(key,{type:"json"}), setJSON(key,val)), env, now }
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (X11; Linux x86_64) fantasy-news-bot/1.0";
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
    let link = decodeEntities(tag(b, "link"));
    if (!link) { const m = b.match(/<link\b[^>]*href="([^"]+)"/); link = m ? decodeEntities(m[1]) : ""; }
    const title = stripHtml(tag(b, "title"));
    return {
      id: tag(b, "guid") || tag(b, "id") || link || title,
      source,
      title,
      body: stripHtml(tag(b, "description") || tag(b, "summary") || tag(b, "content")),
      url: link,
      published: parseDate(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated")),
      names: [],
    };
  });
}

function espnItems(list, source) {
  return (list || []).map((a) => {
    const names = [];
    for (const ath of a.athletes || []) {
      const n = ath.fullName || ath.displayName || ath.description;
      if (n) names.push(n);
    }
    for (const c of a.categories || []) {
      if (c.type === "athlete") {
        const n = c.description || c.athlete?.description;
        if (n) names.push(n);
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
    };
  });
}

export function sourceList(env) {
  const disabled = new Set((env.DISABLE_SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean));
  const all = [
    ["rotowire", (f) => get(f, "https://www.rotowire.com/rss/news.php?sport=NBA").then((x) => parseRss(x, "Rotowire"))],
    ["espn_fantasy", (f) => get(f, "https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players?limit=100")
      .then((x) => { const d = JSON.parse(x); return espnItems(d.feed || d.articles, "ESPN Fantasy"); })],
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

async function fetchAll(fetch, env) {
  const list = sourceList(env);
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

export const webhookSecret = (env) => sha1("fnb-webhook:" + env.TELEGRAM_BOT_TOKEN).slice(0, 32);

export function formatItem(item, hits) {
  const lines = [`🏀 <b>${escapeHtml(hits.join(", "))}</b>  ·  <i>${escapeHtml(item.source)}</i>`];
  if (item.title) lines.push(`<b>${escapeHtml(item.title)}</b>`);
  let body = item.body || "";
  if (body.length > 900) body = body.slice(0, 900).replace(/\s+\S*$/, "") + "…";
  if (body) lines.push(escapeHtml(body));
  if (item.published) lines.push(`<i>${item.published.toISOString().slice(0, 16).replace("T", " ")} UTC</i>`);
  if (item.url) lines.push(`<a href="${escapeHtml(item.url)}">Open</a>`);
  return lines.join("\n");
}

function hitsFor(players, item) {
  const hits = [...item.names.flatMap((n) => matchPlayers(players, n)),
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

  const players = await loadPlayers(store, env);
  const seen = new Set(state.seen);
  const stamp = new Date(now).toISOString().slice(11, 16) + " UTC";
  const outbox = [];

  if (players.length) {
    for (const r of await fetchAll(fetch, env)) {
      if (r.status === "rejected") {
        state.status[r.name] = `ERROR ${String(r.reason?.message || r.reason).slice(0, 100)} @ ${stamp}`;
        log.warn(r.name, "failed:", r.reason?.message);
        continue;
      }
      state.status[r.name] = `ok ${r.value.length} items @ ${stamp}`;
      for (const item of [...r.value].reverse()) { // oldest first
        const key = sha1(item.source.split(" ")[0] + "|" + item.id);
        if (seen.has(key)) continue;
        seen.add(key); state.seen.push(key);
        if (!state.initialized) continue; // first run: just learn existing news
        if (item.published && now - item.published.getTime() > MAX_AGE_MS) continue;
        const hits = hitsFor(players, item);
        if (hits.length) outbox.push(formatItem(item, hits));
      }
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
  state.lastRun = new Date(now).toISOString();
  await store.setJSON("state", state);
  return { sent, players: players.length };
}

// ------------------------------------------------------------- test (/test)
export async function runTestAlerts({ fetch, store, env, limit = 3 }) {
  const players = await loadPlayers(store, env);
  const lines = [];
  const found = [];
  for (const r of await fetchAll(fetch, env)) {
    if (r.status === "rejected") { lines.push(`${r.name}: ERROR ${r.reason?.message}`); continue; }
    const m = r.value.map((i) => [i, hitsFor(players, i)]).filter(([, h]) => h.length);
    lines.push(`${r.name}: ok, ${r.value.length} items, ${m.length} about your players`);
    found.push(...m);
  }
  await send(fetch, env, "🧪 Source check\n" + escapeHtml(lines.join("\n")));
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
  "/remove Name – untrack\n/status – source health\n/test – check sources + send sample alerts";

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
  } else if (cmd === "/status") {
    const st = await loadState(store);
    reply = Object.entries(st.status).map(([k, v]) => `${k}: ${v}`).join("\n") || "No polls yet.";
    reply += `\nLast run: ${st.lastRun || "never"}`;
  } else if (cmd === "/test") {
    await runTestAlerts({ fetch, store, env });
    return "test";
  } else {
    reply = HELP;
  }
  await send(fetch, env, escapeHtml(reply));
  return cmd;
}
