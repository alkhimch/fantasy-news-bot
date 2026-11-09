// Picks the store for a function call: Supabase (+ Blobs for bot state) when SUPABASE_URL and a
// secret key are set, otherwise Netlify Blobs only. Copies customer data from Blobs once.
import { getStore } from "@netlify/blobs";
import { copyToSupabase, supabaseKey, supabaseStore } from "./supabase.mjs";

let migrated = false; // per warm function instance; the Blobs flag covers cold starts

export async function openStore(env = process.env) {
  const blobs = getStore("fantasy-news");
  if (!env.SUPABASE_URL || !supabaseKey(env)) return blobs;
  const store = supabaseStore({ url: env.SUPABASE_URL, key: supabaseKey(env), fetch, ownerId: env.TELEGRAM_CHAT_ID, fallback: blobs });
  if (!migrated) {
    if (!(await blobs.get("supabaseMigrated", { type: "json" }))) {
      // a fresh adapter, so its users snapshot isn't shared with the caller's
      const result = await copyToSupabase(blobs, supabaseStore({ url: env.SUPABASE_URL, key: supabaseKey(env), fetch, ownerId: env.TELEGRAM_CHAT_ID, fallback: blobs }));
      await blobs.setJSON("supabaseMigrated", { at: new Date().toISOString(), ...result });
      console.log("copied customer data to Supabase", result);
    }
    migrated = true;
  }
  return store;
}
