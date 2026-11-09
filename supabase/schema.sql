-- Fantasy news bot: customer data. Run once in Supabase -> SQL Editor.
-- Bot state (seen news, roster cache) stays in Netlify Blobs.

create table if not exists public.users (
  chat_id      bigint primary key,            -- Telegram chat id
  name         text not null default '',
  username     text not null default '',      -- Telegram @username, without @
  status       text not null default 'pending'
               check (status in ('pending', 'active', 'expired', 'blocked')),
  requested_at timestamptz,
  activated_at timestamptz,
  expires_at   timestamptz,                   -- null = no expiry
  note         text not null default '',      -- owner's note, e.g. how they paid
  updated_at   timestamptz not null default now(),
  plan         text not null default 'basic'
               check (plan in ('trial', 'basic', 'unlimited')),
  trial_started_at timestamptz                -- set once: one free trial per Telegram account
);

-- one row per user (the owner too): the whole list as JSON, written in one go
create table if not exists public.players (
  chat_id    bigint primary key,
  list       jsonb not null default '[]',     -- [{name, aliases[], espnId?, team?}]
  updated_at timestamptz not null default now()
);

create table if not exists public.follows (
  chat_id    bigint primary key,
  list       jsonb not null default '[]',     -- [{handle, did, name, lastPostAt, mode: "players"|"all"}]
  updated_at timestamptz not null default now()
);

-- No policies: only the server (secret key) can read or write. The public anon key gets nothing.
alter table public.users   enable row level security;
alter table public.players enable row level security;
alter table public.follows enable row level security;

-- handy view for the Table Editor / SQL: who tracks how many players
create or replace view public.users_overview with (security_invoker = true) as
select u.chat_id, u.name, u.username, u.status, u.plan, u.expires_at, u.note,
       coalesce(jsonb_array_length(p.list), 0) as players,
       coalesce(jsonb_array_length(f.list), 0) as follows,
       u.requested_at, u.activated_at
from public.users u
left join public.players p using (chat_id)
left join public.follows f using (chat_id)
order by u.requested_at desc nulls last;
