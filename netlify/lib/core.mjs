// Fantasy news -> Telegram, Netlify edition. Pure logic; I/O is injected so it can be tested.
// deps: { fetch, store (Netlify Blobs-like: get(key,{type:"json"}), setJSON(key,val)), env, now }
// Multi-user: the owner (TELEGRAM_CHAT_ID) is always active; customers ask via /start and the owner
// opens their access on the admin page (or /approve). Each user has their own players and follows.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// NOTE: ESPN answers 403 to any User-Agent containing "bot".
const UA = "Mozilla/5.0 (X11; Linux x86_64) fantasy-news/1.0";
const MAX_SEEN = 5000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_ALERTS_PER_RUN = 20; // per user
const MAX_SENT_CONTENT = 500; // per user
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
const MAX_PLAYER_FEEDS = 200; // union of all users' players
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
  if (!h) throw new Error(`"${input}" нь Bluesky хаяг биш байна`);
  let p;
  try { p = JSON.parse(await get(fetch, `${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(h)}`)); }
  catch { throw new Error(`Bluesky хаяг олдсонгүй: ${h}`); }
  if (!p?.did) throw new Error(`Bluesky хаяг олдсонгүй: ${h}`);
  let lastPostAt = null;
  try {
    const f = JSON.parse(await get(fetch, bskyFeedUrl(p.did, 5)));
    lastPostAt = (f.feed || []).filter((x) => !x.reason).map((x) => x.post?.record?.createdAt).filter(Boolean).sort().pop() || null;
  } catch { /* profile exists; activity unknown */ }
  return { handle: p.handle, did: p.did, name: p.displayName || "", lastPostAt };
}

export async function loadFollows(store, env, chatId) {
  const key = followsKey(env, chatId);
  let follows = await store.get(key, { type: "json" });
  if (!follows) {
    const seed = env.FOLLOWS != null ? env.FOLLOWS.split(",") : DEFAULT_FOLLOWS;
    follows = seed.map(normalizeHandle).filter(Boolean).map((handle) => ({ handle, mode: "players" }));
    await store.setJSON(key, follows);
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
      bsky: { handle: fo.handle, did: fo.did }, // only users who follow this account get it
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
// "123456:ABC..." -> "123456"
export const botId = (env) => String(env.TELEGRAM_BOT_TOKEN || "").split(":")[0];

export const send = (fetch, env, text, chatId = env.TELEGRAM_CHAT_ID) =>
  tg(fetch, env, "sendMessage", {
    chat_id: chatId, text: text.slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true,
  });

// The owner keeps the original key, so links already saved keep working. Customers: "<chatId>.<hmac>".
const sign = (env, s) => createHmac("sha256", String(env.TELEGRAM_BOT_TOKEN)).update(s).digest("hex").slice(0, 24);
export const webKey = (env, chatId) => (chatId == null || isOwner(env, chatId)
  ? sha1("fnb-web:" + env.TELEGRAM_BOT_TOKEN).slice(0, 24)
  : `${chatId}.${sign(env, "web:" + chatId)}`);
export const webLink = (siteUrl, env, chatId) => `${siteUrl}/?key=${webKey(env, chatId)}`;

const sameText = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
};
// x-key from the web page -> chat id of its user, or null
export function userFromKey(env, key) {
  if (sameText(key, webKey(env))) return ownerId(env);
  const m = String(key ?? "").match(/^(\d+)\.[0-9a-f]{24}$/);
  return m && sameText(key, webKey(env, m[1])) ? m[1] : null;
}
export const adminKey = (env) => sha1("fnb-admin:" + env.TELEGRAM_BOT_TOKEN).slice(0, 24);
export const isAdminKey = (env, key) => sameText(key, adminKey(env));
export const adminLink = (siteUrl, env) => `${siteUrl}/admin.html?key=${adminKey(env)}`;

// Admin page password login: Supabase Auth checks the password, then we hand out a signed
// session "s.<base64url {e, exp}>.<sig>". The email is re-checked against ADMIN_EMAILS on every call,
// so removing it there signs that person out.
const ADMIN_SESSION_MS = 30 * 864e5;
const adminEmails = (env) => (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = (env, email) => adminEmails(env).includes(String(email || "").trim().toLowerCase());
export function adminSession(env, email, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ e: String(email).trim().toLowerCase(), exp: now + ADMIN_SESSION_MS })).toString("base64url");
  return `s.${body}.${sign(env, "admin-session:" + body)}`;
}
export function isAdminSession(env, token, now = Date.now()) {
  const m = String(token ?? "").match(/^s\.([A-Za-z0-9_-]+)\.([0-9a-f]{24})$/);
  if (!m || !sameText(m[2], sign(env, "admin-session:" + m[1]))) return false;
  try {
    const { e, exp } = JSON.parse(Buffer.from(m[1], "base64url").toString());
    return exp > now && isAdminEmail(env, e);
  } catch { return false; }
}
// admin page: the /admin link key or a password-login session
export const isAdmin = (env, key, now) => isAdminKey(env, key) || isAdminSession(env, key, now);

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
  if (item.url) lines.push(`<a href="${escapeHtml(item.url)}">Нээх</a>`);
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

// ----------------------------------------------------------------------- users
// blob "users" = { [chatId]: { chatId, name, username, status, requestedAt, activatedAt, expiresAt, note } }
// status: "pending" (asked, not paid yet) | "active" | "expired" | "blocked". The owner is not in it.
export const ownerId = (env) => String(env.TELEGRAM_CHAT_ID);
export const isOwner = (env, id) => String(id) === ownerId(env);
// the owner keeps the original single-user blob keys
const playersKey = (env, id) => (id == null || isOwner(env, id) ? "players" : `players/${id}`);
const followsKey = (env, id) => (id == null || isOwner(env, id) ? "follows" : `follows/${id}`);

export const loadUsers = async (store) => (await store.get("users", { type: "json" })) || {};
// read-modify-write on a fresh copy, so a poll doesn't overwrite an approval made meanwhile
export async function updateUsers(store, fn) {
  const users = await loadUsers(store);
  const result = fn(users);
  await store.setJSON("users", users);
  return result;
}
export const isActive = (u, now = Date.now()) =>
  u?.status === "active" && (!u.expiresAt || Date.parse(u.expiresAt) > now);

// Plans: "trial" (free, TRIAL_DAYS, same player limit as basic), "basic" (BASIC_PLAYER_LIMIT players),
// "unlimited". A user without a plan (from before plans existed) counts as basic.
export const PLANS = ["trial", "basic", "unlimited"];
const TRIAL_DAYS = (env) => (env.TRIAL_DAYS != null && env.TRIAL_DAYS !== "" ? Number(env.TRIAL_DAYS) : 7);
const BASIC_LIMIT = (env) => Number(env.BASIC_PLAYER_LIMIT) || 10;
const PRICE_BASIC = (env) => env.PRICE_BASIC || env.PRICE || "50,000₮";
const PRICE_UNLIMITED = (env) => env.PRICE_UNLIMITED || "150,000₮";
const planOf = (u) => (PLANS.includes(u?.plan) ? u.plan : "basic");
// max players for a user; Infinity for the owner and the unlimited plan
export const playerLimit = (env, chatId, user) =>
  isOwner(env, chatId) || planOf(user) === "unlimited" ? Infinity : BASIC_LIMIT(env);
const planLabel = (env, plan) => ({
  trial: `Үнэгүй туршилт (${BASIC_LIMIT(env)} хүртэл тоглогч)`,
  basic: `${BASIC_LIMIT(env)} хүртэл тоглогч`,
  unlimited: "Хязгааргүй тоглогч",
})[plan];
const priceLines = (env) => [`• ${BASIC_LIMIT(env)} хүртэл тоглогч – ${PRICE_BASIC(env)}`, `• Хязгааргүй тоглогч – ${PRICE_UNLIMITED(env)}`];
const fmtDate = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10) : ""); // Ulaanbaatar
const userLabel = (u) => [u.name, u.username && "@" + u.username].filter(Boolean).join(" ") || u.chatId;

function paymentText(env, chatId) {
  return [
    "🏀 Fantasy News Bot",
    "",
    "Таны NBA fantasy тоглогчдын шинэ мэдээ (бэртэл, тоглох эсэх, арилжаа гэх мэт) гармагц Telegram-аар шууд мэдэгдэнэ.",
    "",
    "Багцууд:",
    ...priceLines(env),
    "",
    ...howToPay(env, chatId),
  ].join("\n");
}
const howToPay = (env, chatId) => [
  env.PAYMENT_INFO ? env.PAYMENT_INFO.replace(/\\n/g, "\n") : "Төлбөрийн мэдээллийг админаас аваарай.",
  `Гүйлгээний утга: ${chatId}`,
  "Шилжүүлсэн дүнгээр багц тодорхойлогдоно. Төлбөр баталгаажмагц энд мэдэгдэл ирнэ.",
];

// welcome when access opens: trial start, paid access, or a plan change
function welcomeText(env, user, site) {
  const until = user.expiresAt ? ` (${fmtDate(user.expiresAt)} хүртэл)` : "";
  const lines = [user.plan === "trial"
    ? `🎁 ${TRIAL_DAYS(env)} хоногийн үнэгүй туршилт эхэллээ!${until}`
    : `✅ Таны эрх нээгдлээ!${until}`, `Багц: ${planLabel(env, planOf(user))}`, ""];
  if (site) lines.push("Тоглогчоо сонгох:", webLink(site, env, user.chatId), "(Энэ линкийг хэнд ч бүү өг. Дахин авах: /web)", "");
  lines.push(CUSTOMER_COMMANDS);
  return lines.join("\n");
}

// sent with the welcome when access opens
const CUSTOMER_COMMANDS = [
  "Командууд:",
  "/add Нэр – тоглогч нэмэх",
  "   жишээ: /add Nikola Jokic, Stephen Curry",
  "   хочтой: /add Shai Gilgeous-Alexander (SGA)",
  "/remove Нэр – тоглогч хасах",
  "/list – миний тоглогчид",
  "/web – вебээр тоглогч сонгох линк",
  "/plan – миний багц, үнэ",
  "/follow хаяг – Bluesky хаяг дагах (ард нь all гэвэл бүх пост)",
  "/unfollow хаяг – дагахаа болих",
  "/following – дагаж буй хаягууд",
  "/sources – мэдээний эх сурвалжууд",
  "/status – эх сурвалжуудын төлөв",
  "/test – шалгаж, жишээ мэдээ илгээх",
  "/help – командуудын жагсаалт",
].join("\n");

// "2027-06-30" -> end of that day in Ulaanbaatar; "" / null -> no expiry
export function parseExpiry(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T23:59:59+08:00") : new Date(s);
  if (isNaN(d)) throw new Error(`Огноо буруу байна: ${s}`);
  return d.toISOString();
}

// Owner action from the admin page or /approve /block: change a user's access; tells the user when opened.
export async function setUserAccess({ fetch, store, env, chatId, status, expiresAt, note, plan, now = Date.now(), log = console }) {
  const id = String(chatId);
  if (status != null && !["pending", "active", "expired", "blocked"].includes(status)) throw new Error(`Төлөв буруу байна: ${status}`);
  if (plan != null && !PLANS.includes(plan)) throw new Error(`Багц буруу байна: ${plan}`);
  const exp = expiresAt === undefined ? undefined : parseExpiry(expiresAt);
  const { before, user } = await updateUsers(store, (users) => {
    const u = users[id];
    if (!u) return {};
    const before = { ...u };
    if (status != null) u.status = status;
    if (exp !== undefined) u.expiresAt = exp;
    if (note !== undefined) u.note = String(note).slice(0, 200);
    if (plan != null) u.plan = plan;
    else if (status === "active" && planOf(u) === "trial") u.plan = "basic"; // paid after the trial
    if (u.status === "active" && !isActive(before, now)) u.activatedAt = new Date(now).toISOString();
    return { before, user: { ...u } };
  });
  if (!user) throw new Error(`Хэрэглэгч олдсонгүй: ${id}`);
  // tell the user when access opens, or when an active user's plan changes (trial -> paid, upgrade)
  if (isActive(user, now) && (!isActive(before, now) || planOf(before) !== planOf(user))) {
    const site = ((await loadState(store)).webhookUrl || "").replace(/\/telegram$/, "");
    await send(fetch, env, escapeHtml(welcomeText(env, user, site)), id).catch((e) => log.warn("welcome to", id, "failed:", e.message));
  }
  return user;
}

// Admin page list: every user + how many players they track
export async function listUsers(store, env, now = Date.now()) {
  const users = Object.values(await loadUsers(store));
  const order = { pending: 0, active: 1, expired: 2, blocked: 3 };
  const out = await Promise.all(users.map(async (u) => ({
    ...u,
    plan: planOf(u),
    limit: Number.isFinite(playerLimit(env, u.chatId, u)) ? playerLimit(env, u.chatId, u) : null,
    active: isActive(u, now),
    players: ((await store.get(playersKey(env, u.chatId), { type: "json" })) || []).length,
  })));
  return out.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.requestedAt).localeCompare(String(a.requestedAt)));
}

// ----------------------------------------------------------------------- state
export async function loadPlayers(store, env, chatId) {
  const key = playersKey(env, chatId);
  let players = await store.get(key, { type: "json" });
  if (!players) {
    players = key === "players" ? parsePlayerList(env.PLAYERS) : [];
    await store.setJSON(key, players);
  }
  return players;
}
export const savePlayers = (store, env, chatId, players) => store.setJSON(playersKey(env, chatId), players);
const loadState = async (store) =>
  (await store.get("state", { type: "json" })) || { seen: [], status: {}, initialized: false };

// ------------------------------------------------------------------------ poll
export async function runPoll({ fetch, store, env, now = Date.now(), siteUrl, log = console }) {
  const state = await loadState(store);

  // register Telegram webhook (for instant /commands) once per site URL and bot (a new token = a new bot)
  if (siteUrl && (state.webhookUrl !== siteUrl + "/telegram" || state.webhookBot !== botId(env))) {
    try {
      await tg(fetch, env, "setWebhook", {
        url: siteUrl + "/telegram", secret_token: webhookSecret(env), allowed_updates: ["message"],
      });
      state.webhookUrl = siteUrl + "/telegram";
      state.webhookBot = botId(env);
      log.log("webhook set to", state.webhookUrl, "for bot", state.webhookBot);
    } catch (e) { log.warn("setWebhook failed:", e.message); }
  }

  // web links are derived from the token, so a new bot means a new link
  if (siteUrl && (state.webLinkSentFor !== siteUrl || state.webLinkBot !== botId(env))) {
    try {
      await send(fetch, env, `⚙️ Тоглогчоо вебээр сонгох:\n${escapeHtml(webLink(siteUrl, env))}\n(Энэ линкийг хэнд ч бүү өг. Дахин авах: /web)`);
      state.webLinkSentFor = siteUrl;
      state.webLinkBot = botId(env);
    } catch (e) { log.warn("web link send failed:", e.message); }
  }

  await expireUsers({ fetch, store, env, now, log });
  const audience = await loadAudience({ fetch, store, env, now, log });
  const players = unionBy(audience.flatMap((a) => a.players), (p) => p.espnId || stripSuffix(p.name));
  const follows = unionBy(audience.flatMap((a) => a.follows), (f) => f.did || f.handle);
  state.seeded = state.seeded || [];
  const seededAtStart = new Set(state.seeded);
  const seen = new Set(state.seen);
  state.sentBy = state.sentBy || {};
  if (state.sentContent) { state.sentBy[ownerId(env)] = state.sentContent; delete state.sentContent; } // single-user state
  for (const a of audience) {
    a.sentList = state.sentBy[a.id] ||= [];
    a.sent = new Set(a.sentList);
    a.outbox = [];
  }
  const stamp = new Date(now).toISOString().slice(11, 16) + " UTC";

  if (audience.some((a) => a.players.length || a.follows.some((f) => f.mode === "all"))) {
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
        for (const a of audience) {
          const hits = hitsFor(a.players, item);
          let followAll = false;
          if (item.bsky) {
            const f = a.follows.find((x) => x.handle === item.bsky.handle || (x.did && x.did === item.bsky.did));
            if (!f) continue;
            followAll = f.mode === "all";
          }
          if (!hits.length && !followAll) continue;
          const keys = contentKeys(item);
          const dup = keys.some((k) => a.sent.has(k)); // same blurb already sent via another source
          for (const k of keys) if (!a.sent.has(k)) { a.sent.add(k); a.sentList.push(k); }
          if (!dup) a.outbox.push(formatItem(item, hits));
        }
      }
      for (const k of r.value.seedKeys || []) if (!state.seeded.includes(k)) state.seeded.push(k);
    }
    state.initialized = true;
  }

  // users in parallel, each user's messages in order
  const counts = await Promise.all(audience.map(async (a) => {
    let n = 0;
    for (const msg of a.outbox.slice(0, MAX_ALERTS_PER_RUN)) {
      try { await send(fetch, env, msg, a.id); n++; } catch (e) { log.error("send to", a.id, "failed:", e.message); }
    }
    if (a.outbox.length > MAX_ALERTS_PER_RUN) {
      await send(fetch, env, `…бас ${a.outbox.length - MAX_ALERTS_PER_RUN} мэдээ байна.`, a.id).catch(() => {});
    }
    if (a.sentList.length > MAX_SENT_CONTENT) state.sentBy[a.id] = a.sentList.slice(-MAX_SENT_CONTENT);
    return n;
  }));
  if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
  state.lastRun = new Date(now).toISOString();
  await store.setJSON("state", state);
  return { sent: counts.reduce((x, y) => x + y, 0), players: players.length, users: audience.length };
}

function unionBy(list, keyOf) {
  const m = new Map();
  for (const x of list) if (!m.has(keyOf(x))) m.set(keyOf(x), x);
  return [...m.values()];
}

// owner + every customer with active access, each with their own players/follows
async function loadAudience({ fetch, store, env, now, log }) {
  const users = await loadUsers(store);
  const ids = [ownerId(env), ...Object.values(users).filter((u) => isActive(u, now) && !isOwner(env, u.chatId)).map((u) => String(u.chatId))];
  return Promise.all(ids.map(async (id) => {
    const players = await loadPlayers(store, env, id);
    await enrichPlayers({ fetch, store, players, now, log, key: playersKey(env, id) });
    // a list longer than the plan allows (e.g. after a downgrade): only the first ones get alerts
    return { id, players: players.slice(0, playerLimit(env, id, users[id])), follows: await loadFollows(store, env, id) };
  }));
}

// active users whose paid period ended -> "expired"; tell them and the owner once
async function expireUsers({ fetch, store, env, now, log }) {
  const due = Object.values(await loadUsers(store)).filter((u) => u.status === "active" && u.expiresAt && !isActive(u, now));
  if (!due.length) return;
  const done = await updateUsers(store, (users) => due.filter((u) => {
    const cur = users[u.chatId];
    if (!cur || cur.status !== "active" || isActive(cur, now)) return false; // renewed meanwhile
    cur.status = "expired";
    return true;
  }));
  for (const u of done) {
    const trial = planOf(u) === "trial";
    await send(fetch, env, escapeHtml((trial ? "⌛ Таны үнэгүй туршилт дууслаа. Үргэлжлүүлэн ашиглах бол багцаа сонгоорой." : "⌛ Таны эрхийн хугацаа дууслаа.") +
      "\n\n" + paymentText(env, u.chatId)), u.chatId)
      .catch((e) => log.warn("expiry notice to", u.chatId, "failed:", e.message));
    await send(fetch, env, escapeHtml(`⌛ ${trial ? "Туршилт" : "Эрх"} дууслаа: ${userLabel(u)} (${u.chatId})`)).catch(() => {});
  }
}

// ------------------------------------------------------------- test (/test)
export async function runTestAlerts({ fetch, store, env, limit = 3, chatId = ownerId(env) }) {
  const players = await loadPlayers(store, env, chatId);
  const follows = await loadFollows(store, env, chatId);
  const lines = [];
  const found = [];
  for (const r of await fetchAll(fetch, env, players, follows)) {
    if (r.status === "rejected") { lines.push(`${r.name}: алдаа – ${r.reason?.message}`); continue; }
    const m = r.value.map((i) => [i, hitsFor(players, i)]).filter(([, h]) => h.length);
    lines.push(`${r.name}: ok, ${r.value.length} мэдээ, таны тоглогчийн тухай ${m.length}`);
    found.push(...m);
  }
  await send(fetch, env, "🧪 Эх сурвалжийн шалгалт\n" + escapeHtml(lines.join("\n")), chatId);
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
    await send(fetch, env, "Одоогоор таны тоглогчдын тухай мэдээ алга. Өнөөдөр мэдээнд гарсан тоглогчийг /add хийж туршаад үзээрэй.", chatId);
  }
  for (const [item, hits] of found.slice(0, limit)) await send(fetch, env, "🧪 ТЕСТ\n" + formatItem(item, hits), chatId);
  return lines;
}

// -------------------------------------------------------------- commands
const HELP = CUSTOMER_COMMANDS;
const OWNER_HELP =
  "\n\nАдмин:\n/admin – хэрэглэгчдийн хуудасны линк\n/users – хэрэглэгчид, эрхийн байдал\n" +
  "/approve ID [хоног] – эрх нээх (хоноггүй бол хугацаагүй)\n/block ID – эрх хаах";

// A customer who isn't active: register the request, tell the owner once, answer with how to pay.
async function gate({ fetch, store, env, msg, now, log }) {
  const id = String(msg.chat.id);
  const from = msg.from || msg.chat;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 80);
  const username = (from.username || "").slice(0, 40);
  const iso = new Date(now).toISOString();
  const trialDays = TRIAL_DAYS(env);
  const startTrial = (u) => Object.assign(u, { status: "active", plan: "trial", trialStartedAt: iso, activatedAt: iso,
    expiresAt: new Date(now + trialDays * 864e5).toISOString() });
  const { user, isNew, trial } = await updateUsers(store, (users) => {
    const u = users[id];
    if (!u) {
      users[id] = { chatId: id, name, username, status: "pending", requestedAt: iso };
      if (trialDays > 0) return { user: { ...startTrial(users[id]) }, trial: true };
      return { user: users[id], isNew: true };
    }
    Object.assign(u, { name: name || u.name, username: username || u.username });
    if (isActive(u, now) || u.status === "blocked") return { user: { ...u } };
    // asked before trials existed: they get one too
    if (trialDays > 0 && !u.trialStartedAt && u.status === "pending") return { user: { ...startTrial(u) }, trial: true };
    const renewal = u.status !== "pending"; // expired user writes again -> new request
    if (renewal) Object.assign(u, { status: "pending", requestedAt: iso });
    return { user: { ...u }, isNew: renewal };
  });
  if (trial) {
    const site = ((await loadState(store)).webhookUrl || "").replace(/\/telegram$/, "");
    await send(fetch, env, escapeHtml(welcomeText(env, user, site)), id);
    await send(fetch, env, escapeHtml(`🎁 Туршилт эхэллээ: ${userLabel(user)}\nID: ${id}\n${fmtDate(user.expiresAt)} хүртэл`))
      .catch((e) => log.warn("owner notice failed:", e.message));
    return "trial";
  }
  if (isActive(user, now)) return null;
  if (user.status === "blocked") {
    await send(fetch, env, "⛔ Таны эрх хаагдсан байна.", id);
    return "blocked";
  }
  await send(fetch, env, escapeHtml(paymentText(env, id)), id);
  if (isNew) {
    const site = ((await loadState(store)).webhookUrl || "").replace(/\/telegram$/, "");
    await send(fetch, env, escapeHtml(`🆕 Шинэ хүсэлт: ${userLabel(user)}\nID: ${id}\n\n` +
      `Төлбөр орсны дараа: /approve ${id}` + (site ? `\nЭсвэл: ${adminLink(site, env)}` : "")))
      .catch((e) => log.warn("owner notice failed:", e.message));
  }
  return "pending";
}

async function ownerCommand({ fetch, store, env, cmd, arg, now }) {
  if (cmd === "/admin") {
    const site = ((await loadState(store)).webhookUrl || "").replace(/\/telegram$/, "");
    return site ? `🔐 ${adminLink(site, env)}` : "Сайтын хаяг хараахан тодорхойгүй – эхний автомат шалгалтыг (2 минут) хүлээнэ үү.";
  }
  if (cmd === "/users") {
    const list = await listUsers(store, env, now);
    if (!list.length) return "Одоогоор хэрэглэгч алга. Хүн ботод бичихэд энд гарч ирнэ.";
    const icon = { pending: "🕓", active: "✅", expired: "⌛", blocked: "⛔" };
    return list.map((u) => `${icon[u.status] || "•"} ${userLabel(u)} – ${u.chatId} – ${planLabel(env, u.plan)}` +
      (u.expiresAt ? ` – ${fmtDate(u.expiresAt)} хүртэл` : "") + ` – ${u.players} тоглогч`).join("\n");
  }
  if (cmd === "/approve" || cmd === "/block") {
    const [id, ...opts] = arg.split(/\s+/);
    if (!/^\d+$/.test(id || "")) return `Хэрэглээ: ${cmd} ID${cmd === "/approve" ? " [хоног] [unlimited]" : ""}`;
    const days = opts.find((o) => /^\d+$/.test(o));
    const plan = opts.some((o) => /^(unlimited|хязгааргүй)$/i.test(o)) ? "unlimited" : opts.some((o) => /^basic$/i.test(o)) ? "basic" : undefined;
    if (opts.some((o) => !/^\d+$/.test(o) && !/^(unlimited|хязгааргүй|basic)$/i.test(o))) {
      return "Жишээ: /approve 12345 30 (30 хоног) эсвэл /approve 12345 30 unlimited";
    }
    try {
      const u = await setUserAccess({ fetch, store, env, chatId: id, now, plan: cmd === "/approve" ? plan : undefined,
        status: cmd === "/approve" ? "active" : "blocked",
        expiresAt: cmd === "/approve" ? (days ? new Date(now + Number(days) * 864e5).toISOString() : null) : undefined });
      return cmd === "/approve"
        ? `✅ Эрх нээлээ: ${userLabel(u)} – ${planLabel(env, planOf(u))}${u.expiresAt ? ` (${fmtDate(u.expiresAt)} хүртэл)` : " (хугацаагүй)"}`
        : `⛔ Эрх хаалаа: ${userLabel(u)}`;
    } catch (e) { return e.message; }
  }
  return null;
}

export async function handleUpdate({ update, fetch, store, env, now = Date.now(), log = console }) {
  // Telegram retries if we're slow; process each update_id only once.
  // update ids are counted per bot, so after a token change the old bot's last id doesn't apply
  // (a saved id without a bot is from before this was tracked: can't tell which bot, so start over).
  const tgState = (await store.get("tg", { type: "json" })) || { lastUpdateId: 0 };
  if (tgState.bot === botId(env) && update.update_id <= tgState.lastUpdateId) return "duplicate";
  await store.setJSON("tg", { lastUpdateId: update.update_id, bot: botId(env) });

  const msg = update.message || {};
  if (msg.chat?.id == null) return "ignored";
  const chatId = String(msg.chat.id);
  const owner = isOwner(env, chatId);
  if (!owner) {
    if (msg.chat.type !== "private") return "ignored"; // customers only in private chats
    const blocked = await gate({ fetch, store, env, msg, now, log });
    if (blocked) return blocked;
  }
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return "ignored";
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  let reply = owner ? await ownerCommand({ fetch, store, env, cmd, arg, now }) : null;
  if (reply != null) {
    await send(fetch, env, escapeHtml(reply), chatId);
    return cmd;
  }
  let players = await loadPlayers(store, env, chatId);
  const me = owner ? null : (await loadUsers(store))[chatId];
  const limit = playerLimit(env, chatId, me);
  const ofLimit = Number.isFinite(limit) ? `/${limit}` : "";
  if (cmd === "/add" && arg) {
    const added = [], over = [];
    for (const p of parsePlayerList(arg)) {
      if (findPlayer(players, p.name)) continue;
      if (players.length >= limit) { over.push(p.name); continue; }
      players.push(p); added.push(p.name);
    }
    if (added.length) await savePlayers(store, env, chatId, players);
    reply = added.length ? "Нэмлээ: " + added.join(", ") : over.length ? "" : "Аль хэдийн нэмсэн байна.";
    if (over.length) {
      reply += (reply ? "\n\n" : "") + `⚠️ Таны багц ${limit} хүртэл тоглогчтой тул нэмэгдсэнгүй: ${over.join(", ")}\n` +
        `Хязгааргүй багц: ${PRICE_UNLIMITED(env)} – дэлгэрэнгүй: /plan`;
    }
  } else if ((cmd === "/remove" || cmd === "/rm") && arg) {
    const p = findPlayer(players, arg);
    if (p) { players = players.filter((x) => x !== p); await savePlayers(store, env, chatId, players); }
    reply = p ? `Хаслаа: ${p.name}` : `Жагсаалтад алга: ${arg}`;
  } else if (cmd === "/list") {
    const names = players.map((p) => p.name + (p.aliases.length ? ` (${p.aliases.join("/")})` : "")).sort();
    reply = names.length ? `Таны тоглогчид (${names.length}${ofLimit}):\n` + names.map((n) => "• " + n).join("\n") : "Тоглогч алга. Нэмэх: /add Нэр";
  } else if (cmd === "/plan") {
    reply = owner ? "Та эзэмшигч тул хязгааргүй." : [
      `📦 Таны багц: ${planLabel(env, planOf(me))}${me?.expiresAt ? ` – ${fmtDate(me.expiresAt)} хүртэл` : ""}`,
      `Тоглогч: ${players.length}${ofLimit}`, "", "Багцууд:", ...priceLines(env), "",
      "Сунгах эсвэл багцаа солих бол:", ...howToPay(env, chatId),
    ].join("\n");
  } else if (cmd === "/sources") {
    reply = formatSources(await describeSources(store, env, chatId));
  } else if (cmd === "/status") {
    const st = await loadState(store);
    const hhmm = (iso) => iso.slice(11, 16) + " UTC";
    reply = Object.entries(st.sourceStatus || {}).map(([k, v]) => (v.ok
      ? `✅ ${k}: ${v.items} мэдээ · ${hhmm(v.at)}` : `❌ ${k}: алдаа – ${v.error} · ${hhmm(v.at)}`)).join("\n") || "Хараахан шалгаагүй байна.";
    reply += `\nСүүлд шалгасан: ${st.lastRun ? hhmm(st.lastRun) : "хараахан үгүй"}`;
  } else if (cmd === "/follow" && arg) {
    reply = await followCommand({ fetch, store, env, arg, chatId });
  } else if (cmd === "/unfollow" && arg) {
    const follows = await loadFollows(store, env, chatId);
    const h = normalizeHandle(arg);
    const f = follows.find((x) => x.handle === h || x.did === h);
    if (f) await store.setJSON(followsKey(env, chatId), follows.filter((x) => x !== f));
    reply = f ? `Дагахаа болилоо: @${f.handle}` : `Дагаагүй байна: ${arg}`;
  } else if (cmd === "/following" || cmd === "/follow") {
    const follows = await loadFollows(store, env, chatId);
    reply = follows.length
      ? "Дагаж буй Bluesky хаягууд:\n" + follows.map((f) => `• @${f.handle}${f.name ? ` (${f.name})` : ""} – ${f.mode === "all" ? "бүх пост" : "зөвхөн таны тоглогчид"}`).join("\n")
      : "Хэнийг ч дагаагүй байна.";
    reply += "\n\nНэмэх: /follow shamsbot.bsky.social  (бүх пост авах бол ард нь all)";
  } else if (cmd === "/web") {
    const st = await loadState(store);
    const site = (st.webhookUrl || "").replace(/\/telegram$/, "");
    reply = site ? `⚙️ ${webLink(site, env, chatId)}` : "Сайтын хаяг хараахан тодорхойгүй – эхний автомат шалгалтыг (2 минут) хүлээнэ үү.";
  } else if (cmd === "/test") {
    await runTestAlerts({ fetch, store, env, chatId });
    return "test";
  } else {
    reply = HELP + (owner ? OWNER_HELP : "");
  }
  await send(fetch, env, escapeHtml(reply), chatId);
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
    if (!r.players.length) throw new Error("ESPN-ээс NBA-ийн тоглогчдын жагсаалтыг ачаалж чадсангүй");
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
export async function enrichPlayers({ fetch, store, players, now = Date.now(), log = console, key = "players" }) {
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
  if (changed) await store.setJSON(key, players);
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
export async function followCommand({ fetch, store, env, arg, now = Date.now(), chatId }) {
  if (/(^|\/\/|\.)(x|twitter)\.com\b/i.test(arg)) {
    return "X/Twitter-ийг үнэгүй унших боломжгүй – зөвхөн Bluesky хаяг ажиллана.\nЖишээ: /follow shamsbot.bsky.social";
  }
  const parts = arg.split(/\s+/).filter(Boolean);
  const mode = parts.slice(1).some((p) => p.toLowerCase() === "all") ? "all" : "players";
  const follows = await loadFollows(store, env, chatId);
  let info;
  try { info = await resolveBsky(fetch, parts[0]); } catch (e) { return e.message + "\nЖишээ: /follow shamsbot.bsky.social"; }
  const existing = follows.find((f) => f.did === info.did || f.handle === info.handle);
  if (!existing && follows.length >= MAX_FOLLOWS) return `Хамгийн ихдээ ${MAX_FOLLOWS} хаяг дагах боломжтой. Эхлээд нэгийг /unfollow хийнэ үү.`;
  const entry = { handle: info.handle, did: info.did, name: info.name, lastPostAt: info.lastPostAt, mode };
  await store.setJSON(followsKey(env, chatId), existing ? follows.map((f) => (f === existing ? entry : f)) : [...follows, entry]);
  let msg = `${existing ? "Шинэчиллээ" : "Дагаж эхэллээ"}: @${info.handle}${info.name ? ` (${info.name})` : ""} – ` +
    (mode === "all" ? "бүх постыг илгээнэ." : "таны тоглогчдыг дурдсан постыг илгээнэ.");
  const ageDays = info.lastPostAt ? (now - Date.parse(info.lastPostAt)) / 864e5 : Infinity;
  if (ageDays > 30) {
    msg += `\n⚠️ Сүүлийн пост: ${info.lastPostAt ? info.lastPostAt.slice(0, 10) : "алга"} – энэ хаяг идэвхгүй бололтой.`;
  }
  return msg;
}

// validate a follow list coming from the web page; resolves new handles via Bluesky
export async function saveFollowsFromWeb({ fetch, store, env, list, chatId }) {
  if (!Array.isArray(list)) throw new Error("follows must be an array");
  const current = await loadFollows(store, env, chatId);
  const out = [];
  for (const raw of list.slice(0, MAX_FOLLOWS)) {
    const h = normalizeHandle(raw?.handle);
    if (!h) throw new Error(`"${raw?.handle}" нь Bluesky хаяг биш байна`);
    const mode = raw?.mode === "all" ? "all" : "players";
    let entry = current.find((f) => f.handle === h || f.did === h);
    if (!entry || !entry.did) {
      const info = await resolveBsky(fetch, h);
      entry = { handle: info.handle, did: info.did, name: info.name, lastPostAt: info.lastPostAt };
    }
    if (!out.some((f) => f.did === entry.did)) out.push({ ...entry, mode });
  }
  await store.setJSON(followsKey(env, chatId), out);
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

export async function describeSources(store, env, chatId) {
  const state = await loadState(store);
  const players = await loadPlayers(store, env, chatId);
  const follows = await loadFollows(store, env, chatId);
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
  const lines = ["📡 Мэдээний эх сурвалжууд"];
  for (const s of list) {
    let head;
    if (!s.enabled) head = `⏸ ${s.label} – унтраастай`;
    else if (!s.status) head = `⏳ ${s.label} – хараахан шалгаагүй`;
    else if (s.status.ok) head = `✅ ${s.label} – ${s.status.items} мэдээ · ${hhmm(s.status.at)}`;
    else head = `❌ ${s.label} – алдаа: ${s.status.error} · ${hhmm(s.status.at)}`;
    lines.push("", head, "   " + s.mn);
    if (s.detail) lines.push("   " + s.detail.mn);
  }
  lines.push("", "2 минут тутам шалгана. Удирдах: /follow, /add, /web");
  return lines.join("\n");
}
