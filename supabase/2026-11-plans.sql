-- Plans + free trial. Run once in Supabase -> SQL Editor on a database made from an older schema.sql.
-- Safe to run twice.

alter table public.users add column if not exists plan text not null default 'basic';
alter table public.users drop constraint if exists users_plan_check;
alter table public.users add constraint users_plan_check check (plan in ('trial', 'basic', 'unlimited'));
alter table public.users add column if not exists trial_started_at timestamptz;

-- the view gets a new column in the middle, so it is recreated
drop view if exists public.users_overview;
create view public.users_overview with (security_invoker = true) as
select u.chat_id, u.name, u.username, u.status, u.plan, u.expires_at, u.note,
       coalesce(jsonb_array_length(p.list), 0) as players,
       coalesce(jsonb_array_length(f.list), 0) as follows,
       u.requested_at, u.activated_at
from public.users u
left join public.players p using (chat_id)
left join public.follows f using (chat_id)
order by u.requested_at desc nulls last;
