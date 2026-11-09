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
        + `<item><title>Shai Gilgeous-Alexander: Questionable vs. LAL</title><description>SGA (hip) is questionable.

        Visit RotoWire.com for more analysis on this update.</description><guid>rw5</guid><pubDate>Wed, 04 Nov 2099 10:00:00 PM PST</pubDate></item>`
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
  const jok = w.sent.find((t) => t.includes("<b>Nikola Jokic</b>"));
  const sga = w.sent.find((t) => t.includes("<b>Shai Gilgeous-Alexander</b>"));
  assert.ok(jok.includes("Ankle &amp; knee") && jok.includes('href="https://rw/2?a=1&amp;b=2"'), jok);
  assert.ok(sga.includes("SGA (hip) is questionable.") && !sga.includes("Visit RotoWire"), sga);
  assert.ok(sga.includes("2099-11-05 06:00 UTC"), "PM PST parsed: " + sga);
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
  assert.ok(!w.sent[0].includes("espn_fantasy"), "espn_fantasy source removed");
});

test("ESPN videos, recaps and previews are skipped", async () => {
  const store = memStore(); const sent = [];
  const arts = (ids) => ids.map(([id, type]) => ({ id, type, headline: "Nikola Jokic " + type, description: "", published: new Date().toISOString() }));
  let list = arts([[1, "Story"]]);
  const f = async (url, opts) => {
    if (url.startsWith("https://api.telegram.org/")) { if (url.endsWith("sendMessage")) sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ articles: list }) };
  };
  const e = { ...env, DISABLE_SOURCES: "rotowire" };
  const quiet = { log() {}, warn() {}, error() {} };
  await core.runPoll({ fetch: f, store, env: e, log: quiet });
  list = arts([[2, "Media"], [3, "Recap"], [4, "Preview"], [5, "HeadlineNews"], [6, "Story"]]);
  await core.runPoll({ fetch: f, store, env: e, log: quiet });
  assert.deepEqual(sent.map((t) => t.match(/Nikola Jokic (\w+)<\/b>/)[1]).sort(), ["HeadlineNews", "Story"]);
});

test("User-Agent never contains 'bot' (ESPN returns 403)", async () => {
  let ua;
  await core.runPoll({ fetch: async (u, o) => { ua = o.headers["User-Agent"]; return { ok: true, status: 200, text: async () => "<rss></rss>" }; },
    store: memStore(), env: { ...env, DISABLE_SOURCES: "espn_news" }, log: { log() {}, warn() {}, error() {} } });
  assert.ok(ua && !/bot/i.test(ua), ua);
});

test("webhook secret is stable and Telegram-safe", () => {
  assert.match(core.webhookSecret(env), /^[0-9a-f]{32}$/);
});

test("new bot token: webhook and web link set again; old bot's update ids don't block the new bot", async () => {
  const w = world(); const store = memStore();
  const quiet = { log() {}, warn() {}, error() {} };
  const e1 = { ...env, TELEGRAM_BOT_TOKEN: "111:old" }, e2 = { ...env, TELEGRAM_BOT_TOKEN: "222:new" };
  await core.runPoll({ fetch: w.fetch, store, env: e1, siteUrl: "https://x.netlify.app", log: quiet });
  await core.runPoll({ fetch: w.fetch, store, env: e1, siteUrl: "https://x.netlify.app", log: quiet });
  assert.equal(w.tgCalls.filter((c) => c === "setWebhook").length, 1);
  const upd = (id, e) => core.handleUpdate({ update: { update_id: id, message: { chat: { id: 42 }, text: "/list" } }, fetch: w.fetch, store, env: e });
  assert.equal(await upd(900, e1), "/list");
  assert.equal(await upd(900, e1), "duplicate");

  w.sent.length = 0;
  await core.runPoll({ fetch: w.fetch, store, env: e2, siteUrl: "https://x.netlify.app", log: quiet });
  assert.equal(w.tgCalls.filter((c) => c === "setWebhook").length, 2, "webhook registered for the new bot");
  assert.ok(w.sent[0].includes("/?key=" + core.webKey(e2)), "new web link sent");
  assert.equal(await upd(5, e2), "/list", "new bot's lower update id is processed");
  assert.equal(await upd(5, e2), "duplicate");
});

test("update id saved before bots were tracked doesn't block anything", async () => {
  const w = world(); const store = memStore();
  await store.setJSON("tg", { lastUpdateId: 1000 });
  const r = await core.handleUpdate({ update: { update_id: 7, message: { chat: { id: 42 }, text: "/list" } }, fetch: w.fetch, store, env });
  assert.equal(r, "/list");
});
