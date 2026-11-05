import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const okText = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
const quiet = { log() {}, warn() {}, error() {} };
const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Devin Booker, Yves Missi (Missi)" };

test("per-player ESPN feed + Rotowire RSS: same blurb is sent once; names get ESPN ids", async () => {
  const store = memStore(); const sent = []; const calls = [];
  let round = 0;
  const iso = () => new Date().toISOString();
  const f = async (url, opts) => {
    calls.push(url);
    if (url.startsWith("https://api.telegram.org/")) { if (url.endsWith("sendMessage")) sent.push(JSON.parse(opts.body).text); return okText('{"ok":true,"result":{}}'); }
    if (url.endsWith("/nba/teams")) return okText(JSON.stringify({ sports: [{ leagues: [{ teams: Array.from({ length: 30 }, (_, i) => ({ team: { id: String(i + 1), abbreviation: "T" + (i + 1) } })) }] }] }));
    const ro = url.match(/teams\/(\d+)\/roster/);
    if (ro) {
      const base = Array.from({ length: 5 }, (_, j) => ({ id: `${ro[1]}9${j}`, fullName: `P${ro[1]}-${j}` }));
      if (ro[1] === "21") base.push({ id: "3136193", fullName: "Devin Booker" });
      if (ro[1] === "3") base.push({ id: "5061589", fullName: "Yves Missi" });
      return okText(JSON.stringify({ athletes: base }));
    }
    const pf = url.match(/news\/players\?limit=10&playerId=(\d+)/);
    if (pf) {
      const feed = [{ id: 1, type: "Media", headline: "Booker highlight", published: iso() }];
      if (round && pf[1] === "3136193") feed.push({ id: 77, type: "Rotowire", headline: "Booker finished with 33 points (9-19 FG, 2-8 3Pt, 13-13 FT) in a loss.", story: "He has been rolling.", published: iso() });
      if (round && pf[1] === "5061589") feed.push({ id: 78, type: "Rotowire", headline: "Missi (knee) won't play Saturday.", story: "Bone bruise.", published: iso() });
      return okText(JSON.stringify({ feed }));
    }
    if (url.includes("rotowire")) {
      const item = round ? `<item><guid>nba1</guid><title>Devin Booker: Nets 33</title><description>Booker finished with 33 points (9-19 FG, 2-8 3Pt, 13-13 FT) in a loss.

        Visit RotoWire.com for more analysis on this update.</description><pubDate>${new Date().toUTCString()}</pubDate></item>` : "";
      return okText(`<rss><channel>${item}</channel></rss>`);
    }
    if (url.includes("site/v2/sports/basketball/nba/news")) return okText('{"articles":[]}');
    throw new Error("unexpected " + url);
  };

  await core.runPoll({ fetch: f, store, env, log: quiet });
  const players = await store.get("players");
  assert.deepEqual(players.map((p) => [p.name, p.espnId]), [["Devin Booker", "3136193"], ["Yves Missi", "5061589"]]);
  assert.equal(sent.length, 0, "first run silent");

  round = 1; calls.length = 0;
  await core.runPoll({ fetch: f, store, env, log: quiet });
  assert.ok(!calls.some((u) => u.includes("/roster")), "roster served from cache, ids already known");
  const booker = sent.filter((t) => t.includes("33 points"));
  assert.equal(booker.length, 1, "Booker blurb sent once, not twice:\n" + sent.join("\n---\n"));
  const missi = sent.find((t) => t.includes("Missi (knee)"));
  assert.ok(missi.includes("<b>Yves Missi</b>") && missi.includes("Rotowire (ESPN)") && missi.includes("espn.com/nba/player/_/id/5061589"), missi);
  assert.ok(!sent.some((t) => t.includes("highlight")), "videos skipped");
  assert.equal(sent.length, 2);
});
