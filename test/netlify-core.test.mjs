import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42",
              PLAYERS: "Nikola Jokic, Shai Gilgeous-Alexander (SGA), Jaren Jackson Jr., Victor Wembanyama" };

function memStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) };
}

function world() {
  const w = { round: 0, sent: [], tgCalls: [] };
  const rfc = () => new Date().toUTCString();
  w.fetch = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop(); const p = JSON.parse(opts.body);
      w.tgCalls.push(method); if (method === "sendMessage") w.sent.push(p.text);
      return ok(JSON.stringify({ ok: true, result: {} }));
    }
    if (url.includes("rotowire")) {
      let items = `<item><title>Nikola Jokic: Out Tuesday</title><description><![CDATA[Jokic (ankle) <b>won't</b> play.]]></description><link>https://rw/1</link><guid>rw1</guid><pubDate>${rfc()}</pubDate></item>`;
      if (w.round > 0) items += `<item><title>Nikola Jokić: Upgraded</title><description>Ankle &amp;amp; knee better.</description><link>https://rw/2?a=1&amp;b=2</link><guid>rw2</guid><pubDate>${rfc()}</pubDate></item>`
        + `<item><title>Some Guy: Starts</title><description>x</description><guid>rw3</guid><pubDate>${rfc()}</pubDate></item>`
        + `<item><title>Jaren Jackson: old</title><description>old</description><guid>rw4</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`;
      return ok(`<?xml version="1.0"?><rss><channel>${items}</channel></rss>`);
    }
    if (url.includes("fantasy/v2")) {
      const feed = w.round > 0 ? [{ id: 9, headline: "Questionable", story: "SGA (hip) is questionable.", published: new Date().toISOString(), athletes: [{ fullName: "Shai Gilgeous-Alexander" }] }] : [];
      return ok(JSON.stringify({ feed }));
    }
    if (url.includes("site/v2")) {
      if (w.round > 0) return { ok: false, status: 503, text: async () => "" }; // ESPN down this round
      return ok(JSON.stringify({ articles: [] }));
    }
    throw new Error("unexpected " + url);
  };
  return w;
}

test("name matching", () => {
  const ps = core.parsePlayerList(env.PLAYERS);
  assert.deepEqual(ps[1], { name: "Shai Gilgeous-Alexander", aliases: ["SGA"] });
  assert.deepEqual(core.matchPlayers(ps, "Nikola Jokić scores"), ["Nikola Jokic"]);
  assert.deepEqual(core.matchPlayers(ps, "SGA (hip)"), ["Shai Gilgeous-Alexander"]);
  assert.deepEqual(core.matchPlayers(ps, "Jaren Jackson returns"), ["Jaren Jackson Jr."]);
  assert.deepEqual(core.matchPlayers(ps, "Jackson and Nikolai"), []);
});

test("poll: first run silent, then alerts once, webhook set once, errors recorded", async () => {
  const w = world(); const store = memStore();
  const r0 = await core.runPoll({ fetch: w.fetch, store, env, siteUrl: "https://x.netlify.app", log: { log() {}, warn() {}, error() {} } });
  assert.equal(r0.sent, 0);
  assert.deepEqual(w.tgCalls, ["setWebhook", "sendMessage"]);   // webhook + one-time web link
  assert.ok(w.sent[0].includes("/?key="));
  w.sent.length = 0;
  w.round = 1;
  const r1 = await core.runPoll({ fetch: w.fetch, store, env, siteUrl: "https://x.netlify.app", log: { log() {}, warn() {}, error() {} } });
  assert.equal(r1.sent, 2, w.sent.join("\n---\n"));
  assert.ok(w.sent[0].includes("<b>Nikola Jokic</b>") && w.sent[0].includes("Ankle &amp; knee") && w.sent[0].includes('href="https://rw/2?a=1&amp;b=2"'));
  assert.ok(w.sent[1].includes("Shai Gilgeous-Alexander"));
  assert.equal(w.tgCalls.filter((c) => c === "setWebhook").length, 1);
  const st = await store.get("state");
  assert.match(st.status.espn_news, /^ERROR HTTP 503/);
  w.sent.length = 0;
  await core.runPoll({ fetch: w.fetch, store, env, siteUrl: "https://x.netlify.app", log: { log() {}, warn() {}, error() {} } });
  assert.equal(w.sent.length, 0, "no duplicates");
});

test("commands: owner only, dedupe retries, add/remove/list/test", async () => {
  const w = world(); w.round = 1; const store = memStore();
  const upd = (id, text, chat = 42) => core.handleUpdate({ update: { update_id: id, message: { chat: { id: chat }, text } }, fetch: w.fetch, store, env });
  assert.equal(await upd(1, "/add Hacker", 99), "ignored");
  await upd(2, "/add LeBron James (King), Nikola Jokic");
  assert.equal(await upd(2, "/add LeBron James"), "duplicate");
  await upd(3, "/remove sga");
  await upd(4, "/list");
  assert.equal(w.sent[0], "Added: LeBron James");
  assert.equal(w.sent[1], "Removed Shai Gilgeous-Alexander.");
  assert.ok(w.sent[2].includes("LeBron James (King)") && !w.sent[2].includes("Hacker"));
  w.sent.length = 0;
  await upd(5, "/test");
  assert.ok(w.sent[0].startsWith("🧪 Source check") && w.sent[0].includes("espn_news: ERROR"));
  assert.ok(w.sent.slice(1).every((s) => s.startsWith("🧪 TEST")) && w.sent.length >= 2);
});

test("webhook secret is stable and Telegram-safe", () => {
  assert.match(core.webhookSecret(env), /^[0-9a-f]{32}$/);
});
