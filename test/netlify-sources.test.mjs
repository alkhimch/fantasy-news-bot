import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const quiet = { log() {}, warn() {}, error() {} };

test("/sources: statuses after a poll, disabled source, extra feed label, player link detail", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", DISABLE_SOURCES: "espn_news",
                EXTRA_RSS: "Hoops Hype|https://hoopshype.example/rss" };
  const store = memStore(); const sent = [];
  await store.setJSON("players", [{ name: "Nikola Jokic", aliases: [], espnId: "3112335" }, { name: "Some Rookie", aliases: [] }]);
  await store.setJSON("follows", [{ handle: "shamsbot.bsky.social", did: "d1", mode: "players" }, { handle: "thesteinline.bsky.social", did: "d2", mode: "all" }]);
  await store.setJSON("roster", { updatedAt: Date.now(), players: [], teams: [] }); // no roster match for the rookie

  // before any poll
  let list = await core.describeSources(store, env);
  assert.deepEqual(list.map((s) => [s.name, s.enabled, s.status]),
    [["rotowire", true, null], ["espn_player", true, null], ["bluesky", true, null], ["espn_news", false, null], ["extra_1", true, null]]);
  assert.equal(list[4].label, "Hoops Hype");
  assert.match(list[1].detail.en, /^1\/2 players linked to ESPN \(not linked: Some Rookie\)$/);
  assert.match(list[1].detail.mn, /1\/2 тоглогч ESPN-тэй холбогдсон/);
  assert.equal(list[2].detail.en, "@shamsbot, @thesteinline (all)");
  assert.equal(list[2].detail.mn, "@shamsbot, @thesteinline (бүх пост)");

  const f = async (url, opts) => {
    const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
    if (url.startsWith("https://api.telegram.org/")) { if (url.endsWith("sendMessage")) sent.push(JSON.parse(opts.body).text); return ok('{"ok":true,"result":{}}'); }
    if (url.includes("rotowire")) return ok("<rss><channel><item><guid>1</guid><title>x</title></item></channel></rss>");
    if (url.includes("playerId=")) return ok('{"feed":[]}');
    if (url.includes("bsky")) return ok('{"feed":[]}');
    if (url.includes("hoopshype")) return { ok: false, status: 503, text: async () => "" };
    throw new Error("unexpected " + url);
  };
  await core.runPoll({ fetch: f, store, env, log: quiet });
  list = await core.describeSources(store, env);
  const st = Object.fromEntries(list.map((s) => [s.name, s.status]));
  assert.equal(st.rotowire.ok, true); assert.equal(st.rotowire.items, 1);
  assert.equal(st.espn_player.ok, true); assert.equal(st.bluesky.ok, true);
  assert.deepEqual([st.extra_1.ok, st.extra_1.error], [false, "HTTP 503"]);
  assert.equal(st.espn_news, null);

  await core.handleUpdate({ update: { update_id: 1, message: { chat: { id: 42 }, text: "/sources" } }, fetch: f, store, env });
  const msg = sent.at(-1);
  assert.match(msg, /^📡 Мэдээний эх сурвалжууд/);
  assert.match(msg, /✅ Rotowire RSS – 1 мэдээ · \d\d:\d\d UTC/);
  assert.match(msg, /✅ ESPN player feeds – 0 мэдээ/);
  assert.match(msg, /1\/2 тоглогч ESPN-тэй холбогдсон \(холбогдоогүй: Some Rookie\)/);
  assert.match(msg, /⏸ ESPN NBA news – унтраастай/);
  assert.match(msg, /❌ Hoops Hype – алдаа: HTTP 503/);
  assert.match(msg, /@shamsbot, @thesteinline \(бүх пост\)/);
});

test("/sources before first poll shows 'not checked yet'; /help lists /sources", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic" };
  const store = memStore(); const sent = [];
  const f = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true }) }; };
  await core.handleUpdate({ update: { update_id: 1, message: { chat: { id: 42 }, text: "/sources" } }, fetch: f, store, env });
  assert.match(sent[0], /⏳ Rotowire RSS – хараахан шалгаагүй/);
  await core.handleUpdate({ update: { update_id: 2, message: { chat: { id: 42 }, text: "/help" } }, fetch: f, store, env });
  assert.match(sent[1], /\/sources – мэдээний эх сурвалжууд/);
  assert.match(sent[1], /Админ:\n\/admin – /, "owner also sees admin commands");
});

test("/status in Mongolian; alerts link says Нээх", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic" };
  const store = memStore(); const sent = [];
  const f = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true }) }; };
  await core.handleUpdate({ update: { update_id: 1, message: { chat: { id: 42 }, text: "/status" } }, fetch: f, store, env });
  assert.equal(sent[0], "Хараахан шалгаагүй байна.\nСүүлд шалгасан: хараахан үгүй");
  await store.setJSON("state", { seen: [], status: {}, lastRun: "2026-11-10T03:04:00.000Z",
    sourceStatus: { rotowire: { ok: true, items: 5, at: "2026-11-10T03:04:00.000Z" }, espn_news: { ok: false, error: "HTTP 503", at: "2026-11-10T03:04:00.000Z" } } });
  await core.handleUpdate({ update: { update_id: 2, message: { chat: { id: 42 }, text: "/status" } }, fetch: f, store, env });
  assert.equal(sent[1], "✅ rotowire: 5 мэдээ · 03:04 UTC\n❌ espn_news: алдаа – HTTP 503 · 03:04 UTC\nСүүлд шалгасан: 03:04 UTC");
  assert.match(core.formatItem({ source: "ESPN", title: "x", body: "", url: "https://e/1", names: [] }, ["Nikola Jokic"]), /<a href="https:\/\/e\/1">Нээх<\/a>$/);
});
