-- Tilt Rally multiplayer backend. Apply with the Supabase SQL editor or CLI.
create extension if not exists pgcrypto;

create type public.tilt_room_state as enum ('waiting', 'countdown', 'playing', 'finished');
create type public.tilt_player_side as enum ('left', 'right');
create type public.tilt_control_mode as enum ('motion', 'touch');

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  password_hash text not null,
  channel_secret uuid not null default gen_random_uuid(),
  state public.tilt_room_state not null default 'waiting',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);

create table public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  side public.tilt_player_side not null,
  token_hash bytea not null,
  control_mode public.tilt_control_mode,
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (room_id, side),
  unique (room_id, display_name)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  left_player_id uuid not null references public.room_players(id),
  right_player_id uuid not null references public.room_players(id),
  left_score smallint not null default 0 check (left_score between 0 and 7),
  right_score smallint not null default 0 check (right_score between 0 and 7),
  winner_side public.tilt_player_side,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index room_players_room_idx on public.room_players(room_id);
create index rooms_expiry_idx on public.rooms(expires_at);
create index matches_room_idx on public.matches(room_id, started_at desc);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.matches enable row level security;
revoke all on public.rooms, public.room_players, public.matches from anon, authenticated;

create or replace function public.tilt_code()
returns text language plpgsql volatile set search_path = public as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; result text := '';
begin
  for i in 1..6 loop result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
  return result;
end $$;

create or replace function public.tilt_authorise(p_room_id uuid, p_player_id uuid, p_token text)
returns public.room_players language sql stable security definer set search_path = public as $$
  select p.* from public.room_players p join public.rooms r on r.id = p.room_id
  where p.id = p_player_id and p.room_id = p_room_id
    and p.token_hash = digest(p_token, 'sha256') and r.expires_at > now()
$$;

create or replace function public.tilt_room_json(p_room public.rooms)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', p_room.id, 'code', p_room.code, 'state', p_room.state,
    'created_at', p_room.created_at, 'expires_at', p_room.expires_at)
$$;

create or replace function public.tilt_player_json(p public.room_players)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', p.id, 'display_name', p.display_name, 'side', p.side,
    'control_mode', p.control_mode, 'ready', p.ready, 'last_seen_at', p.last_seen_at)
$$;

create or replace function public.create_tilt_room(p_display_name text, p_password text, p_player_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rooms; p public.room_players; clean_name text := btrim(p_display_name); new_code text;
begin
  if char_length(clean_name) not between 1 and 20 then raise exception 'INVALID_NAME'; end if;
  if char_length(p_password) not between 4 and 64 then raise exception 'INVALID_PASSWORD_LENGTH'; end if;
  if nullif(p_player_token, '') is null then raise exception 'INVALID_TOKEN'; end if;
  loop
    new_code := public.tilt_code();
    begin
      insert into public.rooms(code, password_hash) values (new_code, crypt(p_password, gen_salt('bf'))) returning * into r;
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  insert into public.room_players(room_id, display_name, side, token_hash)
  values (r.id, clean_name, 'left', digest(p_player_token, 'sha256')) returning * into p;
  return jsonb_build_object('room', public.tilt_room_json(r), 'player', public.tilt_player_json(p), 'channel_secret', r.channel_secret);
end $$;

create or replace function public.join_tilt_room(p_room_code text, p_display_name text, p_password text, p_player_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rooms; p public.room_players; clean_name text := btrim(p_display_name);
begin
  select * into r from public.rooms where code = upper(btrim(p_room_code)) and expires_at > now() for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.password_hash <> crypt(p_password, r.password_hash) then raise exception 'INVALID_PASSWORD'; end if;
  if r.state <> 'waiting' then raise exception 'ROOM_IN_PROGRESS'; end if;
  if char_length(clean_name) not between 1 and 20 then raise exception 'INVALID_NAME'; end if;
  if exists(select 1 from public.room_players where room_id = r.id and lower(display_name) = lower(clean_name)) then raise exception 'DUPLICATE_NAME'; end if;
  if (select count(*) from public.room_players where room_id = r.id) >= 2 then raise exception 'ROOM_FULL'; end if;
  insert into public.room_players(room_id, display_name, side, token_hash)
  values (r.id, clean_name, 'right', digest(p_player_token, 'sha256')) returning * into p;
  update public.rooms set updated_at = now(), expires_at = now() + interval '2 hours' where id = r.id returning * into r;
  return jsonb_build_object('room', public.tilt_room_json(r), 'player', public.tilt_player_json(p), 'channel_secret', r.channel_secret);
end $$;

create or replace function public.get_tilt_room(p_room_id uuid, p_player_id uuid, p_player_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare caller public.room_players; r public.rooms; player_list jsonb; active_match jsonb;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then raise exception 'UNAUTHORISED'; end if;
  update public.room_players set last_seen_at = now() where id = caller.id;
  update public.rooms set updated_at = now(), expires_at = now() + interval '2 hours' where id = p_room_id returning * into r;
  select coalesce(jsonb_agg(public.tilt_player_json(p) order by p.side), '[]'::jsonb) into player_list from public.room_players p where room_id = p_room_id;
  select jsonb_build_object('id', m.id, 'left_score', m.left_score, 'right_score', m.right_score)
    into active_match from public.matches m where m.room_id = p_room_id and m.finished_at is null order by m.started_at desc limit 1;
  return jsonb_build_object('room', public.tilt_room_json(r), 'players', player_list, 'active_match', active_match);
end $$;

create or replace function public.reconnect_tilt_room(p_room_id uuid, p_player_id uuid, p_player_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare caller public.room_players; r public.rooms;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then raise exception 'UNAUTHORISED'; end if;
  update public.room_players set last_seen_at = now() where id = caller.id;
  select * into r from public.rooms where id = p_room_id;
  return jsonb_build_object('room', public.tilt_room_json(r), 'player', public.tilt_player_json(caller), 'channel_secret', r.channel_secret);
end $$;

create or replace function public.set_tilt_player_ready(p_room_id uuid, p_player_id uuid, p_player_token text, p_control_mode text, p_ready boolean)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then raise exception 'UNAUTHORISED'; end if;
  if p_control_mode not in ('motion', 'touch') then raise exception 'INVALID_CONTROL'; end if;
  if (select state from public.rooms where id = p_room_id) <> 'waiting' then raise exception 'ROOM_IN_PROGRESS'; end if;
  update public.room_players set control_mode = p_control_mode::public.tilt_control_mode, ready = p_ready, last_seen_at = now() where id = caller.id;
end $$;

create or replace function public.start_tilt_match(p_room_id uuid, p_player_id uuid, p_player_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare caller public.room_players; r public.rooms; m public.matches; left_id uuid; right_id uuid;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then raise exception 'UNAUTHORISED'; end if;
  if caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  select * into r from public.rooms where id = p_room_id for update;
  if r.state <> 'waiting' then raise exception 'ROOM_IN_PROGRESS'; end if;
  if (select count(*) from public.room_players where room_id = p_room_id and ready and control_mode is not null) <> 2 then raise exception 'NOT_READY'; end if;
  select id into left_id from public.room_players where room_id = p_room_id and side = 'left';
  select id into right_id from public.room_players where room_id = p_room_id and side = 'right';
  insert into public.matches(room_id, left_player_id, right_player_id) values (p_room_id, left_id, right_id) returning * into m;
  update public.rooms set state = 'countdown', updated_at = now() where id = p_room_id returning * into r;
  return jsonb_build_object('room', public.tilt_room_json(r), 'match_id', m.id);
end $$;

create or replace function public.finish_tilt_match(p_room_id uuid, p_player_id uuid, p_player_token text, p_winner_side text, p_left_score int, p_right_score int)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  if p_winner_side not in ('left', 'right') or greatest(p_left_score, p_right_score) <> 7 then raise exception 'INVALID_RESULT'; end if;
  update public.matches set left_score = p_left_score, right_score = p_right_score,
    winner_side = p_winner_side::public.tilt_player_side, finished_at = now()
  where id = (select id from public.matches where room_id = p_room_id and finished_at is null order by started_at desc limit 1);
  update public.rooms set state = 'finished', updated_at = now() where id = p_room_id;
end $$;

create or replace function public.play_tilt_match(p_room_id uuid, p_player_id uuid, p_player_token text)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  update public.rooms set state = 'playing', updated_at = now() where id = p_room_id and state = 'countdown';
end $$;

create or replace function public.score_tilt_match(p_room_id uuid, p_player_id uuid, p_player_token text, p_left_score int, p_right_score int)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  if p_left_score not between 0 and 7 or p_right_score not between 0 and 7 then raise exception 'INVALID_SCORE'; end if;
  update public.matches set left_score = p_left_score, right_score = p_right_score
  where id = (select id from public.matches where room_id = p_room_id and finished_at is null order by started_at desc limit 1);
end $$;

create or replace function public.reset_tilt_room(p_room_id uuid, p_player_id uuid, p_player_token text)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players; current_state public.tilt_room_state;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then raise exception 'UNAUTHORISED'; end if;
  select state into current_state from public.rooms where id = p_room_id for update;
  if current_state = 'finished' then
    update public.rooms set state = 'waiting', updated_at = now() where id = p_room_id;
    update public.room_players set ready = false where room_id = p_room_id;
  elsif current_state <> 'waiting' then raise exception 'MATCH_ACTIVE';
  end if;
end $$;

create or replace function public.leave_tilt_room(p_room_id uuid, p_player_id uuid, p_player_token text)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null then return; end if;
  if caller.side = 'left' then delete from public.rooms where id = p_room_id;
  else
    delete from public.matches where room_id = p_room_id;
    delete from public.room_players where id = caller.id;
    update public.rooms set state = 'waiting', updated_at = now() where id = p_room_id;
  end if;
end $$;

create or replace function public.expire_tilt_player(p_room_id uuid, p_player_id uuid, p_player_token text)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  if exists(select 1 from public.room_players where room_id = p_room_id and side = 'right' and last_seen_at < now() - interval '30 seconds') then
    delete from public.matches where room_id = p_room_id;
    delete from public.room_players where room_id = p_room_id and side = 'right' and last_seen_at < now() - interval '30 seconds';
  end if;
  update public.rooms set state = 'waiting', updated_at = now() where id = p_room_id;
  update public.room_players set ready = false where room_id = p_room_id;
end $$;

create or replace function public.cleanup_tilt_rooms()
returns integer language plpgsql security definer set search_path = public as $$
declare removed integer;
begin delete from public.rooms where expires_at <= now(); get diagnostics removed = row_count; return removed; end $$;

revoke all on function public.tilt_authorise(uuid,uuid,text) from public;
grant execute on function public.create_tilt_room(text,text,text), public.join_tilt_room(text,text,text,text),
  public.get_tilt_room(uuid,uuid,text), public.reconnect_tilt_room(uuid,uuid,text),
  public.set_tilt_player_ready(uuid,uuid,text,text,boolean), public.start_tilt_match(uuid,uuid,text),
  public.play_tilt_match(uuid,uuid,text),
  public.score_tilt_match(uuid,uuid,text,int,int),
  public.finish_tilt_match(uuid,uuid,text,text,int,int), public.reset_tilt_room(uuid,uuid,text),
  public.leave_tilt_room(uuid,uuid,text), public.expire_tilt_player(uuid,uuid,text) to anon, authenticated;

-- Schedule `select public.cleanup_tilt_rooms();` hourly in Supabase Cron.
