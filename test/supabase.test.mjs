import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";
import { apiBase, copyToSupabase, supabaseStore } from "../netlify/lib/supabase.mjs";

const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const quiet = { log() {}, warn() {}, error() {} };

// Just enough PostgREST: select all / by chat_id, upsert on chat_id. Rows come back like Postgres
// returns them (bigint as number, timestamptz with +00:00).
function fakeSupabase() {
  const db = { users: new Map(), players: new Map(), follows: new Map() };
  const calls = [];
  const pgDate = (v) => (v ? new Date(v).toISOString().replace(/(\.\d*?)0*Z$/, "$1+00:00").replace(".+", "+") : null);
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    calls.push(`${opts.method || "GET"} ${table}`);
    assert.equal(opts.headers.apikey, "sb_secret_x");
    if (!db[table]) return { ok: false, status: 404, text: async () => `relation "public.${table}" does not exist` };
    if ((opts.method || "GET") === "GET") {
      const id = u.searchParams.get("chat_id")?.replace(/^eq\./, "");
      const rows = [...db[table].values()].filter((r) => id == null || String(r.chat_id) === id);
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }
    assert.equal(u.searchParams.get("on_conflict"), "chat_id");
    assert.match(opts.headers.Prefer, /resolution=merge-duplicates/);
    for (const r of JSON.parse(opts.body)) {
      const row = { ...db[table].get(String(r.chat_id)), ...r, chat_id: Number(r.chat_id) };
      for (const c of ["requested_at", "activated_at", "expires_at"]) if (c in row) row[c] = pgDate(row[c]);
      db[table].set(String(r.chat_id), row);
    }
    return { ok: true, status: 201, text: async () => "" };
  };
  return { db, calls, fetch };
}

const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic", FOLLOWS: "", DISABLE_SOURCES: "espn_news,bluesky" };
const open = (sb, blobs) => supabaseStore({ url: "https://p.supabase.co/", key: "sb_secret_x", fetch: sb.fetch, ownerId: "42", fallback: blobs });

test("customer data goes to Supabase tables, bot state stays in Blobs", async () => {
  const sb = fakeSupabase(); const blobs = memStore();
  const store = open(sb, blobs);
  const sent = [];
  const tgFetch = async (url, opts) => {
    if (url.startsWith("https://api.telegram.org/")) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; }
    return { ok: true, status: 200, text: async () => "<rss></rss>" };
  };
  let id = 0;
  const msg = (chat, text) => core.handleUpdate({ update: { update_id: ++id, message: {
    chat: { id: chat, type: "private" }, from: { first_name: "Bat", username: "bat99" }, text } }, fetch: tgFetch, store, env, log: quiet });

  await core.runPoll({ fetch: tgFetch, store, env, siteUrl: "https://s.netlify.app", log: quiet });
  assert.deepEqual(sb.db.players.get("42").list, [{ name: "Nikola Jokic", aliases: [] }], "owner's list seeded from PLAYERS");
  assert.ok(blobs.m.has("state") && blobs.m.has("tg") === false && !blobs.m.has("players"));

  await msg(7, "/start");
  assert.equal(sb.db.users.get("7").status, "pending");
  await msg(42, "/approve 7 30");
  await msg(7, "/add LeBron James");
  await msg(7, "/follow nobody");          // fails at Bluesky lookup; list stays
  const row = sb.db.users.get("7");
  assert.equal(row.status, "active"); assert.equal(row.username, "bat99"); assert.match(row.expires_at, /\+00:00$/);
  assert.deepEqual(sb.db.players.get("7").list.map((p) => p.name), ["LeBron James"]);
  assert.ok(blobs.m.has("tg"));

  const users = await store.get("users");
  assert.equal(users["7"].expiresAt, new Date(row.expires_at).toISOString(), "dates come back as ISO strings");
  assert.equal(typeof users["7"].chatId, "string");
  const list = await core.listUsers(store, env);
  assert.deepEqual(list.map((u) => [u.chatId, u.status, u.players]), [["7", "active", 1]]);
  assert.ok(sent.some((m) => String(m.chat_id) === "7" && m.text.includes("Таны эрх нээгдлээ")));
});

test("a users write sends only the rows that changed", async () => {
  const sb = fakeSupabase(); const store = open(sb, memStore());
  await store.setJSON("users", { 7: { chatId: "7", status: "pending" }, 8: { chatId: "8", status: "pending" } });
  sb.calls.length = 0;
  const posted = [];
  const f = sb.fetch;
  sb.fetch = async (url, opts) => { if (opts.method === "POST") posted.push(...JSON.parse(opts.body).map((r) => String(r.chat_id))); return f(url, opts); };
  const s2 = open(sb, memStore());
  await core.updateUsers(s2, (users) => { users["8"].note = "paid"; });
  assert.deepEqual(posted, ["8"]);
  await core.updateUsers(s2, () => {});
  assert.deepEqual(posted, ["8"], "nothing changed -> no write");
});

test("never-saved list is null (defaults seeded); an emptied list stays empty", async () => {
  const sb = fakeSupabase(); const store = open(sb, memStore());
  assert.equal(await store.get("follows/7"), null);
  await store.setJSON("follows/7", []);
  assert.deepEqual(await store.get("follows/7"), []);
  assert.deepEqual(await core.loadFollows(store, env, "7"), []);
});

test("copyToSupabase: copies once, never overwrites newer Supabase data", async () => {
  const sb = fakeSupabase(); const blobs = memStore();
  await blobs.setJSON("users", { 7: { chatId: "7", name: "Bat", status: "active", expiresAt: "2027-06-30T15:59:59.000Z" }, 8: { chatId: "8", status: "pending" } });
  await blobs.setJSON("players", [{ name: "Nikola Jokic", aliases: [] }]);
  await blobs.setJSON("players/7", [{ name: "LeBron James", aliases: [] }]);
  await blobs.setJSON("follows/7", [{ handle: "shamsbot.bsky.social", mode: "all" }]);
  const store = open(sb, blobs);
  await store.setJSON("players/7", [{ name: "Already In Supabase", aliases: [] }]);
  await store.setJSON("users", { 8: { chatId: "8", status: "active", note: "newer" } });

  const r = await copyToSupabase(blobs, open(sb, blobs));
  assert.deepEqual(r, { users: 1, lists: 2 });
  assert.equal(sb.db.users.get("7").expires_at, "2027-06-30T15:59:59+00:00");
  assert.equal(sb.db.users.get("8").note, "newer");
  assert.deepEqual(sb.db.players.get("7").list.map((p) => p.name), ["Already In Supabase"]);
  assert.equal(sb.db.follows.get("7").list[0].mode, "all");
  assert.deepEqual(sb.db.players.get("42").list.map((p) => p.name), ["Nikola Jokic"]);
  assert.deepEqual(await copyToSupabase(blobs, open(sb, blobs)), { users: 0, lists: 0 }, "second run copies nothing");
});

test("missing tables give a clear error", async () => {
  const sb = fakeSupabase(); delete sb.db.users;
  await assert.rejects(open(sb, memStore()).get("users"), /Supabase GET users: HTTP 404 relation "public.users" does not exist/);
});

test("SUPABASE_URL: dashboard link and /rest/v1 are accepted; a web page gives a clear error", async () => {
  assert.equal(apiBase("https://abc123.supabase.co"), "https://abc123.supabase.co/rest/v1/");
  assert.equal(apiBase(" https://abc123.supabase.co/rest/v1/ "), "https://abc123.supabase.co/rest/v1/");
  assert.equal(apiBase("https://supabase.com/dashboard/project/abc123/editor/1"), "https://abc123.supabase.co/rest/v1/");
  const html = async () => ({ ok: true, status: 200, text: async () => "<!DOCTYPE html><html></html>" });
  const store = supabaseStore({ url: "https://example.com", key: "k", fetch: html, ownerId: "42", fallback: memStore() });
  await assert.rejects(store.get("users"), /web page, not data: SUPABASE_URL must be https:\/\/<project-id>\.supabase\.co \(got https:\/\/example\.com\/rest\/v1\/\)/);
});
