// Telegram webhook: instant replies to /add /remove /list /status /test.
import { getStore } from "@netlify/blobs";
import { handleUpdate, webhookSecret } from "../lib/core.mjs";

export default async (req) => {
  const env = process.env;
  if (req.method !== "POST") return new Response("Fantasy news bot webhook is up.");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret(env)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    await handleUpdate({ update, fetch, env, store: getStore("fantasy-news") });
  } catch (e) {
    console.error("update failed:", e);
  }
  return new Response("ok"); // always 200 so Telegram doesn't retry forever
};

export const config = { path: "/telegram" };
