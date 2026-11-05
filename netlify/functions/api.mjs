// JSON API for the player-picker web page. Every call needs the secret key from /web.
import { getStore } from "@netlify/blobs";
import { describeSources, getRoster, loadFollows, loadPlayers, sanitizePlayers, saveFollowsFromWeb, webKey } from "../lib/core.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const env = process.env;
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "server not configured" }, 500);
  if (req.headers.get("x-key") !== webKey(env)) return json({ error: "unauthorized" }, 401);

  const store = getStore("fantasy-news");
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (path === "/api/roster" && req.method === "GET") {
      return json(await getRoster({ fetch, store }));
    }
    if (path === "/api/players" && req.method === "GET") {
      return json(await loadPlayers(store, env));
    }
    if (path === "/api/players" && req.method === "PUT") {
      const body = await req.json();
      const players = sanitizePlayers(body.players);
      await store.setJSON("players", players);
      return json(players);
    }
    if (path === "/api/sources" && req.method === "GET") {
      return json(await describeSources(store, env));
    }
    if (path === "/api/follows" && req.method === "GET") {
      return json(await loadFollows(store, env));
    }
    if (path === "/api/follows" && req.method === "PUT") {
      const body = await req.json();
      try {
        return json(await saveFollowsFromWeb({ fetch, store, env, list: body.follows }));
      } catch (e) {
        return json({ error: e.message }, 400); // e.g. unknown handle
      }
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(path, e);
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/api/*" };
