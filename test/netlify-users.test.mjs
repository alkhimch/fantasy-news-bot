import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic", FOLLOWS: "",
              DISABLE_SOURCES: "espn_news,bluesky", PAYMENT_INFO: "Хаан банк 5000123456 (Бат)", TRIAL_DAYS: "0" };
const quiet = { log() {}, warn() {}, error() {} };
const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const okText = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });

function world(e = env) {
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
    fetch: w.fetch, store: w.store, env: e, now: w.now, log: quiet });
  w.poll = () => core.runPoll({ fetch: w.fetch, store: w.store, env: e, now: w.now, siteUrl: "https://s.netlify.app", log: quiet });
  w.item = (guid, title) => { w.rss += `<item><guid>${guid}</guid><title>${title}</title><description>${title} news.</description><pubDate>${new Date(w.now ?? Date.now()).toUTCString()}</pubDate></item>`; };
  return w;
}

test("customer asks, gets payment info; owner told once; commands closed until approved", async () => {
  const w = world();
  assert.equal(await w.msg(7, "/start"), "pending");
  assert.match(w.to(7)[0], /Багцууд:\n• 10 хүртэл тоглогч – 50,000₮\n• Хязгааргүй тоглогч – 150,000₮\n\nХаан банк 5000123456 \(Бат\)\nГүйлгээний утга: 7/);
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
  assert.match(w.to(42).at(-1), /^✅ Эрх нээлээ: Bat @bat99 – 10 хүртэл тоглогч \(\d{4}-\d\d-\d\d хүртэл\)$/);
  const welcome = w.to(7).at(-1);
  assert.match(welcome, /✅ Таны эрх нээгдлээ! \(\d{4}-\d\d-\d\d хүртэл\)/);
  assert.ok(welcome.includes("https://s.netlify.app/?key=" + core.webKey(env, "7")), welcome);
  for (const c of ["/add", "/remove", "/list", "/web", "/follow", "/unfollow", "/following", "/sources", "/status", "/test", "/help"]) {
    assert.ok(welcome.includes("\n" + c + " "), "welcome lists " + c);
  }
  assert.ok(!/\/approve|\/block|\/users|\/admin/.test(welcome), "no owner commands");

  await w.msg(7, "/add LeBron James");
  assert.equal(w.to(7).at(-1), "Нэмлээ: LeBron James");
  await w.msg(7, "/list");
  assert.ok(w.to(7).at(-1).includes("LeBron James") && !w.to(7).at(-1).includes("Jokic"));
  await w.msg(42, "/list");
  assert.ok(w.to(42).at(-1).includes("Nikola Jokic") && !w.to(42).at(-1).includes("LeBron"));
  await w.msg(7, "/web");
  assert.equal(w.to(7).at(-1), "⚙️ https://s.netlify.app/?key=" + core.webKey(env, "7"));
  await w.msg(7, "/approve 7");
  assert.ok(!w.to(7).at(-1).startsWith("✅ Эрх нээлээ"), "customers can't use admin commands");
  assert.ok(w.to(7).at(-1).startsWith("Командууд:") && !w.to(7).at(-1).includes("Админ"), "customers get the help without admin part");

  await w.msg(42, "/users");
  assert.match(w.to(42).at(-1), /✅ Bat @bat99 – 7 – 10 хүртэл тоглогч – \d{4}-\d\d-\d\d хүртэл – 1 тоглогч/);
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
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "99", status: "active" }), /Хэрэглэгч олдсонгүй/);
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", expiresAt: "soon" }), /Огноо буруу/);
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env, chatId: "7", status: "vip" }), /Төлөв буруу/);
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

test("admin password-login sessions: signed, 30 days, revoked by removing the email", () => {
  const e = { ...env, ADMIN_EMAILS: "Owner@Mail.mn, second@mail.mn" };
  assert.ok(core.isAdminEmail(e, " owner@mail.MN ")); assert.ok(!core.isAdminEmail(e, "x@mail.mn"));
  const now = Date.parse("2026-11-09T00:00:00Z");
  const t = core.adminSession(e, "owner@mail.mn", now);
  assert.ok(core.isAdminSession(e, t, now + 29 * 864e5));
  assert.ok(!core.isAdminSession(e, t, now + 31 * 864e5), "expired");
  assert.ok(!core.isAdminSession({ ...e, ADMIN_EMAILS: "second@mail.mn" }, t, now), "email removed");
  assert.ok(!core.isAdminSession({ ...e, TELEGRAM_BOT_TOKEN: "other" }, t, now), "other token");
  const [, body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "owner@mail.mn", exp: now + 999 * 864e5 })).toString("base64url");
  assert.ok(!core.isAdminSession(e, `s.${forged}.${sig}`, now), "body can't be changed");
  assert.ok(core.isAdmin(e, core.adminKey(e), now) && core.isAdmin(e, t, now), "link key and session both work");
  assert.ok(!core.isAdmin(e, core.webKey(e), now) && !core.isAdmin(e, null, now));
  assert.ok(body.length > 10);
});

const trialEnv = { ...env, TRIAL_DAYS: "7" };
const twelve = Array.from({ length: 12 }, (_, i) => `Player ${String.fromCharCode(65 + i)}`);

test("trial: starts on first message, 10-player limit, ends after 7 days, only once", async () => {
  const w = world(trialEnv);
  w.now = Date.parse("2026-11-10T00:00:00Z");
  await w.poll();
  assert.equal(await w.msg(7, "/start"), "trial");
  const welcome = w.to(7)[0];
  assert.match(welcome, /^🎁 7 хоногийн үнэгүй туршилт эхэллээ! \(2026-11-17 хүртэл\)\nБагц: Үнэгүй туршилт \(10 хүртэл тоглогч\)/);
  assert.ok(welcome.includes("/?key=" + core.webKey(trialEnv, "7")) && welcome.includes("\n/plan "));
  assert.match(w.to(42).at(-1), /^🎁 Туршилт эхэллээ: Bat @bat99\nID: 7\n2026-11-17 хүртэл$/);
  const u = (await w.store.get("users"))["7"];
  assert.deepEqual([u.status, u.plan, u.trialStartedAt], ["active", "trial", "2026-11-10T00:00:00.000Z"]);

  await w.msg(7, "/add " + twelve.join(", "));
  assert.match(w.to(7).at(-1), /^Нэмлээ: Player A, .*Player J\n\n⚠️ Таны багц 10 хүртэл тоглогчтой тул нэмэгдсэнгүй: Player K, Player L\nХязгааргүй багц: 150,000₮ – дэлгэрэнгүй: \/plan$/);
  assert.equal((await w.store.get("players/7")).length, 10);
  await w.msg(7, "/list");
  assert.match(w.to(7).at(-1), /^Таны тоглогчид \(10\/10\):/);
  await w.msg(7, "/plan");
  assert.match(w.to(7).at(-1), /^📦 Таны багц: Үнэгүй туршилт \(10 хүртэл тоглогч\) – 2026-11-17 хүртэл\nТоглогч: 10\/10\n\nБагцууд:\n• 10 хүртэл тоглогч – 50,000₮\n• Хязгааргүй тоглогч – 150,000₮/);

  w.now += 8 * 864e5;
  w.sent.length = 0;
  await w.poll();
  assert.match(w.to(7)[0], /^⌛ Таны үнэгүй туршилт дууслаа\./);
  assert.match(w.to(42)[0], /^⌛ Туршилт дууслаа: Bat @bat99 \(7\)/);
  assert.equal(await w.msg(7, "/list"), "pending", "no second trial");
  assert.match(w.to(42).at(-1), /^🆕 Шинэ хүсэлт: Bat @bat99/);

  await w.msg(42, "/approve 7 30");
  assert.match(w.to(42).at(-1), /^✅ Эрх нээлээ: Bat @bat99 – 10 хүртэл тоглогч \(/);
  assert.match(w.to(7).at(-1), /^✅ Таны эрх нээгдлээ! \(\d{4}-\d\d-\d\d хүртэл\)\nБагц: 10 хүртэл тоглогч/);
});

test("plans: paying during the trial, upgrading to unlimited, /approve options", async () => {
  const w = world(trialEnv);
  await w.poll();
  await w.msg(7, "/start");
  await w.msg(42, "/approve 7 30");                        // paid while still on trial -> basic, told
  assert.equal((await w.store.get("users"))["7"].plan, "basic");
  assert.match(w.to(7).at(-1), /^✅ Таны эрх нээгдлээ!.*\nБагц: 10 хүртэл тоглогч/);
  await w.msg(7, "/add " + twelve.join(", "));
  assert.equal((await w.store.get("players/7")).length, 10);

  await w.msg(42, "/approve 7 90 unlimited");
  assert.match(w.to(42).at(-1), /– Хязгааргүй тоглогч \(/);
  assert.match(w.to(7).at(-1), /\nБагц: Хязгааргүй тоглогч/, "user told about the upgrade");
  await w.msg(7, "/add Player K, Player L");
  assert.equal(w.to(7).at(-1), "Нэмлээ: Player K, Player L");
  await w.msg(7, "/list");
  assert.match(w.to(7).at(-1), /^Таны тоглогчид \(12\):/);
  const n = w.to(7).length;
  await w.msg(42, "/approve 7 120");                       // renewal keeps the plan, no new welcome
  assert.equal((await w.store.get("users"))["7"].plan, "unlimited");
  assert.equal(w.to(7).length, n);

  await w.msg(42, "/approve 7 soon");
  assert.match(w.to(42).at(-1), /^Жишээ: \/approve 12345 30/);
  const list = await core.listUsers(w.store, trialEnv);
  assert.deepEqual([list[0].plan, list[0].limit, list[0].players], ["unlimited", null, 12]);
  await assert.rejects(core.setUserAccess({ fetch: w.fetch, store: w.store, env: trialEnv, chatId: "7", plan: "gold" }), /Багц буруу/);
});

test("someone who asked before trials existed gets a trial; a long list after a downgrade alerts for the first 10 only", async () => {
  const w = world(trialEnv);
  w.now = Date.now();
  await w.poll();
  await w.store.setJSON("users", { 7: { chatId: "7", name: "Old", status: "pending", requestedAt: "2026-11-01T00:00:00.000Z" },
                                   8: { chatId: "8", status: "active", plan: "basic" } });
  assert.equal(await w.msg(7, "hi"), "trial");
  await w.store.setJSON("players/8", twelve.map((name) => ({ name, aliases: [] })));
  w.sent.length = 0;
  w.item("j", "Player J: Out");
  w.item("k", "Player K: Out");
  await w.poll();
  assert.deepEqual(w.to(8).map((t) => t.match(/<b>(.*?)<\/b>/)[1]), ["Player J"]);
});

test("TRIAL_DAYS=0 turns the trial off", async () => {
  const w = world({ ...env, TRIAL_DAYS: "0" });
  assert.equal(await w.msg(7, "/start"), "pending");
});
