import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const okJson = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
const quiet = { log() {}, warn() {}, error() {} };
const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Yves Missi" };

test("normalizeHandle", () => {
  assert.equal(core.normalizeHandle("@ShamsBot"), "shamsbot.bsky.social");
  assert.equal(core.normalizeHandle("thesteinline.bsky.social"), "thesteinline.bsky.social");
  assert.equal(core.normalizeHandle("https://bsky.app/profile/rotowirenba.bsky.social/post/3abc"), "rotowirenba.bsky.social");
  assert.equal(core.normalizeHandle("did:plc:abc123"), "did:plc:abc123");
  assert.equal(core.normalizeHandle("bad handle!"), "");
  assert.equal(core.normalizeHandle(""), "");
});

function bskyWorld() {
  const w = { posts: {}, profiles: {
    "shamsbot.bsky.social": { did: "did:plc:shams", handle: "shamsbot.bsky.social", displayName: "Shams Charania Tweets" },
    "thesteinline.bsky.social": { did: "did:plc:stein", handle: "thesteinline.bsky.social", displayName: "Marc Stein" },
    "rotowirenba.bsky.social": { did: "did:plc:roto", handle: "rotowirenba.bsky.social", displayName: "RotoWire NBA" },
    "old.bsky.social": { did: "did:plc:old", handle: "old.bsky.social", displayName: "Old" } }, sent: [], rss: "" };
  const byActor = (a) => Object.values(w.profiles).find((p) => p.did === a || p.handle === a);
  let n = 0;
  w.post = (handle, text, { ago = 0, repost = false } = {}) => {
    const p = w.profiles[handle]; const uri = `at://${p.did}/app.bsky.feed.post/r${++n}`;
    (w.posts[p.did] ||= []).unshift({ ...(repost ? { reason: { $type: "repost" } } : {}),
      post: { uri, author: { handle }, record: { text, createdAt: new Date(Date.now() - ago).toISOString() } } });
  };
  w.fetch = async (url, opts) => {
    if (url.startsWith("https://api.telegram.org/")) { if (url.endsWith("sendMessage")) w.sent.push(JSON.parse(opts.body).text); return okJson({ ok: true, result: {} }); }
    const u = new URL(url); const actor = u.searchParams.get("actor");
    if (u.pathname.endsWith("app.bsky.actor.getProfile")) { const p = byActor(actor); return p ? okJson(p) : { ok: false, status: 400, text: async () => "{}" }; }
    if (u.pathname.endsWith("app.bsky.feed.getAuthorFeed")) { const p = byActor(actor); return okJson({ feed: (w.posts[p?.did] || []).slice(0, +u.searchParams.get("limit")) }); }
    if (url.includes("rotowire.com/rss")) return { ok: true, status: 200, text: async () => `<rss><channel>${w.rss}</channel></rss>` };
    if (url.includes("site/v2/sports/basketball/nba/news")) return okJson({ articles: [] });
    throw new Error("unexpected " + url);   // roster etc. -> source error, ignored
  };
  w.cmd = (id, text) => core.handleUpdate({ update: { update_id: id, message: { chat: { id: 42 }, text } }, fetch: w.fetch, store: w.store, env });
  w.poll = () => core.runPoll({ fetch: w.fetch, store: w.store, env, log: quiet });
  w.store = memStore();
  return w;
}

test("follows: default accounts, player filter, reposts ignored, new follow seeded, 'all' mode, cross-source dedupe", async () => {
  const w = bskyWorld();
  w.post("shamsbot.bsky.social", "Old news: Yves Missi signs extension", { ago: 3600e3 });
  await w.poll();                                   // global first run: silent
  assert.equal(w.sent.length, 0);
  assert.deepEqual((await w.store.get("follows")).map((f) => f.handle), ["shamsbot.bsky.social", "thesteinline.bsky.social"]);

  w.post("shamsbot.bsky.social", "Sources: Pelicans' Yves Missi (knee) will miss 2-3 weeks.");
  w.post("thesteinline.bsky.social", "How close are the Warriors to trading Kristaps Porzingis?");
  w.post("shamsbot.bsky.social", "Yves Missi repost", { repost: true });
  await w.poll();
  assert.equal(w.sent.length, 1, w.sent.join("\n---\n"));
  assert.match(w.sent[0], /🏀 <b>Yves Missi<\/b>  ·  <i>Bluesky @shamsbot<\/i>/);
  assert.match(w.sent[0], /https:\/\/bsky\.app\/profile\/shamsbot\.bsky\.social\/post\/r\d+/);

  // follow RotoWire with 'all': its existing posts must NOT be sent
  w.post("rotowirenba.bsky.social", "Devin Booker: Nets game-high 33 points in loss");
  w.post("rotowirenba.bsky.social", "Some Guy: Starts Wednesday");
  w.sent.length = 0;
  await w.cmd(1, "/follow @rotowirenba all");
  assert.match(w.sent[0], /Дагаж эхэллээ: @rotowirenba\.bsky\.social \(RotoWire NBA\) – бүх постыг илгээнэ\./);
  w.sent.length = 0;
  await w.poll();
  assert.equal(w.sent.length, 0, "old posts of a newly followed account are skipped");

  // next: a new RotoWire post (no tracked player) is sent in 'all' mode with 📣 header;
  // the same blurb via Rotowire RSS (title line) is deduped
  w.post("rotowirenba.bsky.social", "LaMelo Ball: Totals 20 points in win  https://www.rotowire.com/x");
  w.rss = `<item><guid>nba9</guid><title>LaMelo Ball: Totals 20 points in win</title><description>Ball totaled 20 points.</description><pubDate>${new Date().toUTCString()}</pubDate></item>`;
  await w.poll();
  assert.equal(w.sent.length, 1, w.sent.join("\n---\n"));
  assert.match(w.sent[0], /^📣 <i>Bluesky @rotowirenba<\/i>/);
});

test("/follow, /following, /unfollow and error cases", async () => {
  const w = bskyWorld();
  await w.cmd(1, "/follow nobody.bsky.social");
  assert.match(w.sent.at(-1), /Bluesky хаяг олдсонгүй: nobody\.bsky\.social/);
  await w.cmd(2, "/follow https://x.com/ShamsCharania");
  assert.match(w.sent.at(-1), /X\/Twitter-ийг үнэгүй унших боломжгүй/);
  await w.cmd(3, "/follow old.bsky.social");
  assert.match(w.sent.at(-1), /⚠️ Сүүлийн пост: алга – энэ хаяг идэвхгүй бололтой/);
  w.post("thesteinline.bsky.social", "hi");
  await w.cmd(4, "/follow thesteinline.bsky.social all");     // update existing default entry
  assert.match(w.sent.at(-1), /^Шинэчиллээ: @thesteinline/);
  assert.ok(!/идэвхгүй/.test(w.sent.at(-1)));
  await w.cmd(5, "/following");
  assert.match(w.sent.at(-1), /@thesteinline\.bsky\.social \(Marc Stein\) – бүх пост/);
  assert.match(w.sent.at(-1), /@old\.bsky\.social \(Old\) – зөвхөн таны тоглогчид/);
  await w.cmd(6, "/unfollow @old");
  assert.match(w.sent.at(-1), /Дагахаа болилоо: @old\.bsky\.social/);
  assert.deepEqual((await w.store.get("follows")).map((f) => f.handle), ["shamsbot.bsky.social", "thesteinline.bsky.social"]);
});

test("saveFollowsFromWeb resolves new handles and rejects unknown ones", async () => {
  const w = bskyWorld();
  const out = await core.saveFollowsFromWeb({ fetch: w.fetch, store: w.store, env,
    list: [{ handle: "shamsbot.bsky.social", mode: "all" }, { handle: "@rotowirenba" }, { handle: "rotowirenba.bsky.social" }] });
  assert.deepEqual(out.map((f) => [f.handle, f.did, f.mode]),
    [["shamsbot.bsky.social", "did:plc:shams", "all"], ["rotowirenba.bsky.social", "did:plc:roto", "players"]]);
  await assert.rejects(core.saveFollowsFromWeb({ fetch: w.fetch, store: w.store, env, list: [{ handle: "nobody.bsky.social" }] }), /олдсонгүй/);
  await assert.rejects(core.saveFollowsFromWeb({ fetch: w.fetch, store: w.store, env, list: [{ handle: "bad handle" }] }), /Bluesky хаяг биш/);
  assert.equal((await w.store.get("follows")).length, 2, "failed save leaves list unchanged");
});

test("same Rotowire blurb from RSS, ESPN copy and RotoWire Bluesky in one poll -> sent once", async () => {
  const w = bskyWorld();
  await w.store.setJSON("players", [{ name: "Devin Booker", aliases: [], espnId: "3136193" }]);
  await w.store.setJSON("follows", [{ handle: "rotowirenba.bsky.social", did: "did:plc:roto", mode: "players" }]);
  let espn = [];
  const base = w.fetch;
  w.fetch = async (url, opts) => url.includes("news/players?limit=10&playerId=3136193")
    ? okJson({ feed: espn }) : base(url, opts);
  await w.poll(); // first run
  const now = new Date();
  w.post("rotowirenba.bsky.social", "Devin Booker: Nets game-high 33 points in loss \n\n https://www.rotowire.com/x");
  espn = [{ id: 501, type: "Rotowire", headline: "Booker finished with 33 points (9-19 FG, 2-8 3Pt, 13-13 FT) in a loss.", story: "Analysis.", published: now.toISOString() }];
  w.rss = `<item><guid>nba1</guid><title>Devin Booker: Nets game-high 33 points in loss</title><description>Booker finished with 33 points (9-19 FG, 2-8 3Pt, 13-13 FT) in a loss.</description><pubDate>${now.toUTCString()}</pubDate></item>`;
  await w.poll();
  assert.equal(w.sent.filter((t) => t.includes("33 points")).length, 1, w.sent.join("\n---\n"));
  w.sent.length = 0;
  await core.runTestAlerts({ fetch: w.fetch, store: w.store, env, limit: 5 });
  assert.equal(w.sent.filter((t) => t.startsWith("🧪 ТЕСТ")).length, 1, "/test dedupes too");
});

test("Bluesky posts go only to users who follow that account, with their own mode", async () => {
  const w = bskyWorld();
  const to = [];
  const base = w.fetch;
  w.fetch = async (url, opts) => {
    if (url.endsWith("sendMessage")) to.push([String(JSON.parse(opts.body).chat_id), JSON.parse(opts.body).text]);
    return base(url, opts);
  };
  await w.store.setJSON("users", { 7: { chatId: "7", status: "active" }, 8: { chatId: "8", status: "active" } });
  await w.store.setJSON("players/7", [{ name: "Yves Missi", aliases: [] }]);
  await w.store.setJSON("follows/7", []);                                                   // follows nobody
  await w.store.setJSON("players/8", []);
  await w.store.setJSON("follows/8", [{ handle: "thesteinline.bsky.social", mode: "all" }]); // every Stein post
  await w.poll();
  w.post("shamsbot.bsky.social", "Yves Missi (knee) will miss 2-3 weeks.");
  w.post("thesteinline.bsky.social", "Warriors talk on the pod today.");
  await w.poll();
  const by = (id) => to.filter(([c]) => c === id).map(([, t]) => t);
  assert.equal(by("42").length, 1); assert.match(by("42")[0], /Yves Missi/);   // owner: default follows, owner's player
  assert.deepEqual(by("7"), [], "user 7 doesn't follow shamsbot");
  assert.equal(by("8").length, 1); assert.match(by("8")[0], /^📣 <i>Bluesky @thesteinline<\/i>/);
});
