// Customer data (users, players, follows) in Supabase via its REST API (PostgREST); everything else
// (bot state, roster cache) goes to `fallback` (Netlify Blobs). Same get/setJSON interface as a Blobs
// store, so core.mjs doesn't know which one it talks to. Tables: supabase/schema.sql.
const FETCH_TIMEOUT_MS = 8000;

// core's user object <-> users row
const USER_COLS = [["chatId", "chat_id"], ["name", "name"], ["username", "username"], ["status", "status"],
  ["requestedAt", "requested_at"], ["activatedAt", "activated_at"], ["expiresAt", "expires_at"], ["note", "note"]];
const DATE_FIELDS = new Set(["requestedAt", "activatedAt", "expiresAt"]);
const TEXT_FIELDS = new Set(["name", "username", "note"]);

function fromRow(r) {
  const u = {};
  for (const [k, col] of USER_COLS) {
    const v = r[col];
    u[k] = k === "chatId" ? String(v) : DATE_FIELDS.has(k) ? (v ? new Date(v).toISOString() : null) : v ?? (TEXT_FIELDS.has(k) ? "" : null);
  }
  return u;
}
function toRow(u, now) {
  const r = { updated_at: now };
  for (const [k, col] of USER_COLS) r[col] = TEXT_FIELDS.has(k) ? String(u[k] ?? "") : (u[k] ?? null);
  return r;
}

export const supabaseKey = (env) => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";

// "https://abc.supabase.co", also forgiving ".../rest/v1" and the dashboard link ".../dashboard/project/abc"
export function apiBase(url) {
  const s = String(url || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const dash = s.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  return (dash ? `https://${dash[1]}.supabase.co` : s) + "/rest/v1/";
}

export function supabaseStore({ url, key, fetch, ownerId, fallback }) {
  const base = apiBase(url);
  async function rest(path, { method = "GET", body, prefer } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    if (method !== "GET") return null;
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      throw new Error(`Supabase answered with a web page, not data: SUPABASE_URL must be https://<project-id>.supabase.co (got ${base})`);
    }
  }
  const upsert = (table, rows) =>
    rest(`${table}?on_conflict=chat_id`, { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });

  // "players" -> owner's list, "players/123" -> user 123's list
  const listKey = (key) => {
    const m = String(key).match(/^(players|follows)(?:\/(-?\d+))?$/);
    return m && { table: m[1], chatId: m[2] ?? String(ownerId) };
  };

  // users as last read, so a write only sends the rows that changed (and can't undo
  // another request's change to a different user)
  let lastUsers = {};

  return {
    async get(key, opts) {
      if (key === "users") {
        const rows = await rest("users?select=*");
        const users = Object.fromEntries(rows.map((r) => [String(r.chat_id), fromRow(r)]));
        lastUsers = JSON.parse(JSON.stringify(users));
        return users;
      }
      const l = listKey(key);
      if (l) {
        const rows = await rest(`${l.table}?chat_id=eq.${l.chatId}&select=list`);
        return rows[0]?.list ?? null; // null = never saved, so core seeds the defaults
      }
      return fallback.get(key, opts);
    },
    async setJSON(key, value) {
      const now = new Date().toISOString();
      if (key === "users") {
        const changed = Object.values(value).filter((u) => JSON.stringify(u) !== JSON.stringify(lastUsers[u.chatId]));
        if (changed.length) await upsert("users", changed.map((u) => toRow(u, now)));
        lastUsers = JSON.parse(JSON.stringify(value));
        return;
      }
      const l = listKey(key);
      if (l) return upsert(l.table, [{ chat_id: l.chatId, list: value, updated_at: now }]);
      return fallback.setJSON(key, value);
    },
  };
}

// Supabase Auth email + password check, server side. Returns the user's email or throws a message
// for the login form.
export async function passwordSignIn({ url, key, fetch, email, password }) {
  const res = await fetch(apiBase(url).replace(/rest\/v1\/$/, "auth/v1/token?grant_type=password"), {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 400) throw new Error("Буруу и-мэйл эсвэл нууц үг.");
  if (res.status === 429) throw new Error("Хэт олон оролдлого. Хэсэг хүлээгээд дахин оролдоно уу.");
  if (!res.ok || !data.user?.email) throw new Error(`Supabase Auth: HTTP ${res.status} ${data.msg || data.error_description || data.message || ""}`.trim());
  return data.user.email;
}

// One-time copy of customer data from Blobs. Never overwrites what Supabase already has.
export async function copyToSupabase(from, to) {
  const users = (await from.get("users", { type: "json" })) || {};
  const keys = ["players", "follows", ...Object.keys(users).flatMap((id) => [`players/${id}`, `follows/${id}`])];
  let copied = 0;
  for (const k of keys) {
    const v = await from.get(k, { type: "json" });
    if (v != null && (await to.get(k, { type: "json" })) == null) { await to.setJSON(k, v); copied++; }
  }
  const existing = await to.get("users", { type: "json" });
  const missing = Object.keys(users).filter((id) => !existing[id]);
  if (missing.length) await to.setJSON("users", { ...existing, ...Object.fromEntries(missing.map((id) => [id, users[id]])) });
  return { users: missing.length, lists: copied };
}
