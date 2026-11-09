// Runs on a schedule: checks news sources and sends Telegram alerts.
import { runPoll } from "../lib/core.mjs";
import { openStore } from "../lib/store.mjs";

export default async (req, context) => {
  const env = process.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Netlify environment variables");
    return new Response("missing env", { status: 500 });
  }
  const result = await runPoll({
    fetch, env,
    store: await openStore(env),
    siteUrl: context?.site?.url || env.URL,
  });
  console.log("poll done", result);
  return new Response("ok");
};

export const config = { schedule: "*/2 * * * *" };
