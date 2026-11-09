import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic", FOLLOWS: "",
              DISABLE_SOURCES: "espn_news,bluesky", PAYMENT_INFO: "Хаан банк 5000123456 (Бат)" };
const quiet = { log() {}, warn() {}, error() {} };
const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const okText = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });

function world() {
  const w = { sent: [], rss: "", store: memStore(), id: 0 };
  w.fetch = async (url, opts) => {
    if (url.startsWith("https://api.telegram.org/")) {
      const p = JSON.parse(opts.body);
      if (url.endsWith("sendMessage")) w.sent.push({ to: String(p.chat_id), text: p.text });
      return okText('{"ok":true,"result":{}}');
    }
    if (url.includes("rotowire.com/rss")) return okText(`<rss><channel>${w.rss}</channel></rss>`);
    throw new Error("unexpected " + url); // roster / player feeds -> source error, ignored
  };
  w.to = (id) => w.sent.filter((s) => s.to === String(id)).map((s) => s.text);
  w.msg = (chat, text, extra = {}) => core.handleUpdate({ update: { update_id: ++w.id, message: {
    chat: { id: chat, type: chat === 42 ? undefined : "private" }, from: { first_name: "Bat", username: "bat99" }, text, ...extra } },
    fetch: w.fetch, store: w.store, env, now: w.now, log: quiet });
  w.poll = () => core.runPoll({ fetch: w.fetch, store: w.store, env, now: w.now, siteUrl: "https://s.netlify.app", log: quiet });
  w.item = (guid, title) => { w.rss += `<item><guid>${guid}</guid><title>${title}</title><description>${title} news.</description><pubDate>${new Date(w.now ?? Date.now()).toUTCString()}</pubDate></item>`; };
  return w;
}

test("customer asks, gets payment info; owner told once; commands closed until approved", async () => {
  const w = world();
  assert.equal(await w.msg(7, "/start"), "pending");
  assert.match(w.to(7)[0], /Үнэ: 50,000₮\nХаан банк 5000123456 \(Бат\)\nГүйлгээний утга: 7/);
  assert.match(w.to(42)[0], /🆕 Шинэ хүсэлт: Bat @bat99\nID: 7\n\nТөлбөр орсны дараа: \/approve 7/);
  assert.equal(await w.msg(7, "/add LeBron James"), "pending");
  assert.equal(w.to(42).length, 1, "owner not notified twice");
  assert.equal(w.to(7).length, 2);
  assert.equal(await w.store.get("players/7"), null, "nothing added before approval");
  const users = await w.store.get("users");
  assert.deepEqual([users["7"].status, users["7"].name, users["7"].username], ["pending", "Bat", "bat99"]);
  assert.equal(await w.msg(-100, "/start", { chat: { id: -100, type: "group" } }), "ignored", "groups ignored");
});

test("/approve opens access with a private web link; players are per user", async () => {
  const w = world();
  await w.poll(); // learns the site URL
  await w.msg(7, "/start");
  await w.msg(42, "/approve 7 30");
  assert.match(w.to(42).at(-1), /^✅ Opened: Bat @bat99 until \d{4}-\d\d-\d\d$/);
  const welcome = w.to(7).at(-1);
  assert.match(welcome, /✅ Таны эрх нээгдлээ! \(\d{4}-\d\d-\d\d хүртэл\)/);
  assert.ok(welcome.includes("https://s.netlify.app/?key=" + core.webKey(env, "7")), welcome);

  await w.msg(7, "/add LeBron James");
  assert.equal(w.to(7).at(-1), "Added: LeBron James");
  await w.msg(7, "/list");
  assert.ok(w.to(7).at(-1).includes("LeBron James") && !w.to(7).at(-1).includes("Jokic"));
  await w.msg(42, "/list");
  assert.ok(w.to(42).at(-1).includes("Nikola Jokic") && !w.to(42).at(-1).includes("LeBron"));
  await w.msg(7, "/web");
  assert.equal(w.to(7).at(-1), "⚙️ https://s.netlify.app/?key=" + core.webKey(env, "7"));
  await w.msg(7, "/approve 7");
  assert.ok(!w.to(7).at(-1).startsWith("✅ Opened"), "customers can't use admin commands");

  await w.msg(42, "/users");
  assert.match(w.to(42).at(-1), /✅ Bat @bat99 – 7 – until \d{4}-\d\d-\d\d – 1 players/);
  await w.msg(42, "/block 7");
  assert.equal(await w.msg(7, "/list"), "blocked");
  assert.equal(w.to(7).at(-1), "⛔ Таны эрх хаагдсан байна.");
});

test("poll: each user gets only news about their own players", async () => {
  const w = world();
  w.now = Date.now();
  await w.poll();
  for (const id of [7, 8, 9]) await w.msg(id, "/start");
  await w.msg(42, "/approve 7");
  await w.msg(42, "/approve 8");          // 9 stays pending
  await w.msg(7, "/add LeBron James, Nikola Jokic");
  await w.msg(8, "/add Stephen Curry");
  await w.msg(9, "/add Some Guy");        // ignored: not active
  w.sent.length = 0;
  w.item("a", "Nikola Jokic: Out Tuesday");
  w.item("b", "LeBron James: Questionable");
  w.item("c", "Stephen Curry: Starts");
  await w.poll();
  assert.deepEqual(w.to(42).map((t) => t.match(/<b>(.*?)<\/b>/)[1]), ["Nikola Jokic"]);
  assert.deepEqual(w.to(7).map((t) => t.match(/<b>(.*?)<\/b>/)[1]).sort(), ["LeBron James", "Nikola Jokic"]);
  assert.deepEqual(w.to(8).map((t) => t.match(/<b>(.*?)<\/b>/)[1]), ["Stephen Curry"]);
  assert.deepEqual(w.to(9), []);
  w.sent.length = 0;
  await w.poll();
  assert.equal(w.sent.length, 0, "no repeats");
});

test("access expires: user and owner told once, alerts stop, writing again is a renewal request", async () => {
  const w = world();
  w.now = Date.parse("2026-11-09T00:00:00Z");
  await w.poll();
  await w.msg(7, "/start");
  await w.msg(42, "/approve 7 1");
  await w.msg(7, "/add LeBron James");
  w.now += 2 * 864e5;
  w.sent.length = 0;
  w.item("x", "LeBron James: Out");
  await w.poll();
  assert.match(w.to(7)[0], /^⌛ Таны эрхийн хугацаа дууслаа\./);
  assert.equal(w.to(7).length, 1, "no news after expiry");
  assert.match(w.to(42)[0], /⌛ Эрх дууслаа: Bat @bat99 \(7\)/);
  assert.equal((await w.store.get("users"))["7"].status, "expired");
  await w.poll();
  assert.equal(w.sent.length, 2, "expiry notices sent once");
  assert.equal(await w.msg(7, "/list"), "pending");
  assert.match(w.to(42).at(-1), /🆕 Шинэ хүсэлт: Bat @bat99/);
});

test("admin page access: setUserAccess, listUsers, dates in Ulaanbaatar time", async () => {
  const w = world();
  await w.poll();
  await w.msg(7, "/start");
  w.sent.length = 0;
  const u = await core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", status: "active", expiresAt: "2027-06-30", note: "Хаан банк 11/09", log: quiet });
  assert.equal(u.expiresAt, "2027-06-30T15:59:59.000Z");
  assert.equal(u.note, "Хаан банк 11/09");
  assert.match(w.to(7)[0], /✅ Таны эрх нээгдлээ! \(2027-06-30 хүртэл\)/);
  await core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", note: "renewed", log: quiet });
  assert.equal(w.to(7).length, 1, "editing a note doesn't re-send the welcome");
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "99", status: "active" }), /unknown user/);
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", expiresAt: "soon" }), /bad date/);
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", status: "vip" }), /bad status/);
  const list = await core.listUsers(w.store, env);
  assert.deepEqual(list.map((x) => [x.chatId, x.status, x.active, x.players]), [["7", "active", true, 0]]);
});

test("web keys: owner keeps the old key, customer keys can't be forged", () => {
  assert.equal(core.userFromKey(env, core.webKey(env)), "42");
  assert.equal(core.webKey(env, "42"), core.webKey(env));
  const k7 = core.webKey(env, "7");
  assert.match(k7, /^7\.[0-9a-f]{24}$/);
  assert.equal(core.userFromKey(env, k7), "7");
  assert.equal(core.userFromKey(env, "8" + k7.slice(1)), null);
  assert.equal(core.userFromKey(env, k7.slice(0, -1) + (k7.endsWith("0") ? "1" : "0")), null);
  assert.equal(core.userFromKey(env, null), null);
  assert.ok(core.isAdminKey(env, core.adminKey(env)));
  assert.ok(!core.isAdminKey(env, core.webKey(env)));
});

test("single-user state is carried over: no repeat alerts after the upgrade", async () => {
  const w = world();
  await w.poll();
  w.item("a", "Nikola Jokic: Out Tuesday");
  await w.poll();
  assert.equal(w.to(42).filter((t) => t.includes("Jokic")).length, 1);
  const st = await w.store.get("state");
  st.sentContent = st.sentBy["42"]; delete st.sentBy; // what the old version saved
  st.seen = st.seen.filter(() => false);               // pretend the same blurb arrives with a new id
  await w.store.setJSON("state", st);
  w.rss = w.rss.replace("<guid>a</guid>", "<guid>a2</guid>");
  w.sent.length = 0;
  await w.poll();
  assert.equal(w.sent.length, 0);
  const st2 = await w.store.get("state");
  assert.ok(!("sentContent" in st2) && st2.sentBy["42"].length > 0);
});
