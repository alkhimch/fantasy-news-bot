// JSON API for the web pages. Player-picker calls need the user's key from /web;
// /api/admin/* needs the owner's admin key from /admin or a session from /api/admin/login.
import {
  adminSession, describeSources, getRoster, isActive, isAdmin, isAdminEmail, isOwner, listUsers, loadFollows, loadPlayers,
  loadUsers, sanitizePlayers, saveFollowsFromWeb, savePlayers, setUserAccess, userFromKey,
} from "../lib/core.mjs";
import { openStore } from "../lib/store.mjs";
import { passwordSignIn, supabaseKey } from "../lib/supabase.mjs";

const BAD_LOGIN = "Буруу и-мэйл эсвэл нууц үг.";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const env = process.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ error: "server not configured" }, 500);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const key = req.headers.get("x-key");
  try {
    if (path === "/api/admin/login" && req.method === "POST") {
      if (!env.SUPABASE_URL || !supabaseKey(env) || !env.ADMIN_EMAILS) {
        return json({ error: "Нууц үгээр нэвтрэх тохиргоо хийгдээгүй байна (SUPABASE_URL, SUPABASE_SECRET_KEY, ADMIN_EMAILS). Telegram дээр /admin линкээр орно уу." }, 400);
      }
      const { email, password } = await req.json().catch(() => ({}));
      if (!email || !password) return json({ error: "И-мэйл, нууц үгээ оруулна уу." }, 400);
      if (!isAdminEmail(env, email)) return json({ error: BAD_LOGIN }, 401); // same answer: don't reveal who is admin
      try {
        const verified = await passwordSignIn({ url: env.SUPABASE_URL, key: supabaseKey(env), fetch, email: String(email).trim(), password: String(password) });
        if (!isAdminEmail(env, verified)) return json({ error: BAD_LOGIN }, 401);
        return json({ token: adminSession(env, verified), email: verified.toLowerCase() });
      } catch (e) {
        return json({ error: e.message }, 401);
      }
    }
    const store = await openStore(env);
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin(env, key)) return json({ error: "unauthorized" }, 401);
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
