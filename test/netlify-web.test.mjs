import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../netlify/lib/core.mjs";

const env = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", PLAYERS: "Nikola Jokic" };
const memStore = () => { const m = new Map(); return { m,
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => m.set(k, JSON.stringify(v)) }; };
const ok = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });

function espnFetch({ teamsDown = false, grouped = false, failTeams = [] } = {}) {
  const calls = { n: 0 };
  const f = async (url) => {
    calls.n++;
    if (url.endsWith("/nba/teams")) {
      if (teamsDown) return { ok: false, status: 500, text: async () => "" };
      return ok({ sports: [{ leagues: [{ teams: Array.from({ length: 30 }, (_, i) =>
        ({ team: { id: String(i + 1), abbreviation: "T" + (i + 1), displayName: "Team " + (i + 1) } })) }] }] });
    }
    const id = url.match(/teams\/(\d+)\/roster/)[1];
    if (failTeams.includes(id)) return { ok: false, status: 500, text: async () => "" };
    const athletes = Array.from({ length: 5 }, (_, j) => ({
      id: `${id}0${j}`, fullName: id === "7" && j === 0 ? "Nikola Jokić" : `P${id}-${j}`,
      position: { abbreviation: "C" }, headshot: { href: `https://img/${id}${j}.png` },
      injuries: j === 1 ? [{ status: "Out" }] : [] }));
    return ok(grouped ? { team: { abbreviation: "G" + id }, athletes: [{ position: "x", items: athletes }] } : { athletes });
  };
  return { f, calls };
}

test("roster: flat format, cached 12h", async () => {
  const store = memStore(); const { f, calls } = espnFetch();
  const r = await core.getRoster({ fetch: f, store, now: 1e12 });
  assert.equal(r.players.length, 150); assert.equal(r.teams.length, 30);
  const jok = r.players.find((p) => p.name === "Nikola Jokić");
  assert.deepEqual(jok, { id: "700", name: "Nikola Jokić", team: "T7", pos: "C", headshot: "https://img/70.png", injury: "" });
  assert.equal(r.players.find((p) => p.id === "701").injury, "Out");
  const n = calls.n;
  await core.getRoster({ fetch: f, store, now: 1e12 + 3600e3 });
  assert.equal(calls.n, n, "served from cache");
  await core.getRoster({ fetch: f, store, now: 1e12 + 13 * 3600e3 });
  assert.ok(calls.n > n, "refreshed after 12h");
});

test("roster: grouped format + teams endpoint down -> ids 1..30", async () => {
  const { f } = espnFetch({ teamsDown: true, grouped: true });
  const r = await core.getRoster({ fetch: f, store: memStore() });
  assert.equal(r.players.length, 150);
  assert.equal(r.players.find((p) => p.id === "700").team, "G7");
});

test("roster: many teams failing keeps previous copy", async () => {
  const store = memStore();
  await core.getRoster({ fetch: espnFetch().f, store, now: 1 });
  const bad = espnFetch({ failTeams: Array.from({ length: 20 }, (_, i) => String(i + 1)) }).f;
  const r = await core.getRoster({ fetch: bad, store, now: 1 + 13 * 3600e3 });
  assert.equal(r.players.length, 150);
  assert.equal(r.updatedAt, 1);
});

test("sanitizePlayers", () => {
  const out = core.sanitizePlayers([
    { name: "  Nikola   Jokic ", espnId: "3112335<script>", team: "DEN!" },
    { name: "nikola jokić" },                // duplicate
    { name: "" }, { foo: 1 }, null,
    { name: "Shai Gilgeous-Alexander", aliases: ["SGA", 5, ""] },
  ]);
  assert.deepEqual(out, [
    { name: "Nikola Jokic", aliases: [], espnId: "3112335", team: "DEN" },
    { name: "Shai Gilgeous-Alexander", aliases: ["SGA", "5"] },
  ]);
  assert.throws(() => core.sanitizePlayers("x"));
});

test("ESPN athlete id matches even when the name differs; /web; link sent once", async () => {
  const store = memStore(); const sent = [];
  await store.setJSON("players", [{ name: "Jokic the Joker", aliases: [], espnId: "3112335" }]);
  let round = 0;
  const f = async (url, opts) => {
    if (url.startsWith("https://api.telegram.org/")) { if (url.endsWith("sendMessage")) sent.push(JSON.parse(opts.body).text); return ok({ ok: true, result: {} }); }
    if (url.includes("site/v2")) return ok({ articles: round ? [{ id: 1, headline: "Nuggets win", description: "big night",
      published: new Date().toISOString(), categories: [{ type: "athlete", athleteId: 3112335, description: "N. Jokic" }] }] : [] });
    return ok({ feed: [] });
  };
  const e2 = { ...env, DISABLE_SOURCES: "rotowire" };
  const quiet = { log() {}, warn() {}, error() {} };
  await core.runPoll({ fetch: f, store, env: e2, siteUrl: "https://s.netlify.app", log: quiet });
  assert.equal(sent.length, 1); assert.ok(sent[0].includes("https://s.netlify.app/?key=" + core.webKey(env)));
  round = 1;
  await core.runPoll({ fetch: f, store, env: e2, siteUrl: "https://s.netlify.app", log: quiet });
  assert.equal(sent.length, 2, "link not re-sent; one alert");
  assert.ok(sent[1].includes("Jokic the Joker"));
  await core.handleUpdate({ update: { update_id: 1, message: { chat: { id: 42 }, text: "/web" } }, fetch: f, store, env: e2 });
  assert.equal(sent[2], "⚙️ https://s.netlify.app/?key=" + core.webKey(env));
});
