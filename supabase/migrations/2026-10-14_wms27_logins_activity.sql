-- ShipShape wms27 / StitchLab: individual logins, who-did-what log, pack batches.
-- Safe to run more than once. Nothing existing is removed.

-- 1) Individual logins (username + 4-digit PIN), shared by ShipShape and StitchLab
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists person text;          -- StitchLab team name this login times as (e.g. 'Drea')
alter table public.profiles add column if not exists active boolean not null default true;
create unique index if not exists profiles_username_uq on public.profiles (lower(username)) where username is not null;

-- Everyone signed in can see the roster (names on logs and history)
drop policy if exists profiles_read_all on public.profiles;
create policy profiles_read_all on public.profiles for select to authenticated using (true);

-- Close a gap: a Team login could update its own profile row, including role.
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;            -- service role / SQL editor
  if public.is_lead() then return new; end if;
  if new.role is distinct from old.role or new.username is distinct from old.username
     or new.active is distinct from old.active or new.person is distinct from old.person then
    raise exception 'Only a lead can change role, username, person or active';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg before update on public.profiles
  for each row execute function public.profiles_guard();

-- Name the two existing logins
update public.profiles set display_name = 'Taylor', person = 'Taylor'
  where full_name = 'twahlgren@taylormadescrubhats.com' and display_name is null;
update public.profiles set display_name = 'Team (shared)'
  where full_name = 'tmshteam@taylormadescrubhats.com' and display_name is null;

-- 2) Pack batches: every order packed in one pack cycle shares a batch id
alter table public.pack_sessions add column if not exists batch_id uuid;
create index if not exists pack_sessions_batch_idx on public.pack_sessions (batch_id);
create index if not exists pack_sessions_user_idx on public.pack_sessions (user_id, verified_at desc);

-- 3) Who did what, across both tools
create table if not exists public.activity_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id uuid default auth.uid() references auth.users(id) on delete set null,
  app text not null default 'shipshape',
  action text not null,
  order_number text,
  batch_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index if not exists activity_log_user_idx on public.activity_log (user_id, created_at desc);
create index if not exists activity_log_time_idx on public.activity_log (created_at desc);
create index if not exists activity_log_batch_idx on public.activity_log (batch_id);
alter table public.activity_log enable row level security;
drop policy if exists al_insert on public.activity_log;
create policy al_insert on public.activity_log for insert to authenticated with check (user_id = auth.uid());
drop policy if exists al_select on public.activity_log;
create policy al_select on public.activity_log for select to authenticated
  using (user_id = auth.uid() or public.is_lead());

-- 4) Time entries carry the login that logged them
alter table public.time_entries add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists time_entries_user_idx on public.time_entries (user_id, started_at desc);
create index if not exists time_entries_person_idx on public.time_entries (person, started_at desc);

-- Timers: a personal login may only start/stop/edit time under its own name; leads can fix anyone's.
-- The old shared team login (no person set) keeps working until it's retired.
create or replace function public.my_person() returns text language sql stable security definer set search_path = public as $$
  select p.person from public.profiles p where p.id = auth.uid()
$$;
drop policy if exists te_insert on public.time_entries;
create policy te_insert on public.time_entries for insert to authenticated
  with check (public.is_lead() or public.my_person() is null or person = public.my_person());
drop policy if exists te_update on public.time_entries;
create policy te_update on public.time_entries for update to authenticated
  using (public.is_lead() or public.my_person() is null or created_by = auth.uid() or person = public.my_person())
  with check (public.is_lead() or public.my_person() is null or person = public.my_person());
