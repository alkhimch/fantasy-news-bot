// JSON API for the web pages. Player-picker calls need the user's key from /web;
// /api/admin/* needs the owner's admin key from /admin.
import { getStore } from "@netlify/blobs";
import {
  describeSources, getRoster, isActive, isAdminKey, isOwner, listUsers, loadFollows, loadPlayers, loadUsers,
  sanitizePlayers, saveFollowsFromWeb, savePlayers, setUserAccess, userFromKey,
} from "../lib/core.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const env = process.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ error: "server not configured" }, 500);
  const store = getStore("fantasy-news");
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const key = req.headers.get("x-key");
  try {
    if (path.startsWith("/api/admin/")) {
      if (!isAdminKey(env, key)) return json({ error: "unauthorized" }, 401);
      if (path === "/api/admin/users" && req.method === "GET") {
        return json(await listUsers(store, env));
      }
      const m = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (m && req.method === "PUT") {
        const body = await req.json();
        try {
          return json(await setUserAccess({ fetch, store, env, chatId: m[1], status: body.status, expiresAt: body.expiresAt, note: body.note }));
        } catch (e) {
          return json({ error: e.message }, 400); // unknown user, bad date/status
        }
      }
      return json({ error: "not found" }, 404);
    }

    const chatId = userFromKey(env, key);
    if (!chatId) return json({ error: "unauthorized" }, 401);
    if (!isOwner(env, chatId) && !isActive((await loadUsers(store))[chatId])) return json({ error: "inactive" }, 403);

    if (path === "/api/roster" && req.method === "GET") {
      return json(await getRoster({ fetch, store }));
    }
    if (path === "/api/players" && req.method === "GET") {
      return json(await loadPlayers(store, env, chatId));
    }
    if (path === "/api/players" && req.method === "PUT") {
      const body = await req.json();
      const players = sanitizePlayers(body.players);
      await savePlayers(store, env, chatId, players);
      return json(players);
    }
    if (path === "/api/sources" && req.method === "GET") {
      return json(await describeSources(store, env, chatId));
    }
    if (path === "/api/follows" && req.method === "GET") {
      return json(await loadFollows(store, env, chatId));
    }
    if (path === "/api/follows" && req.method === "PUT") {
      const body = await req.json();
      try {
        return json(await saveFollowsFromWeb({ fetch, store, env, list: body.follows, chatId }));
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
