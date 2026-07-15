-- Configurable rounds and games for Tilt Rally multiplayer.
alter table public.rooms
  add column round_count smallint not null default 1 check (round_count between 1 and 10),
  add column games_per_round smallint not null default 10 check (games_per_round between 1 and 10);

alter table public.matches
  add column round_count smallint not null default 1 check (round_count between 1 and 10),
  add column games_per_round smallint not null default 10 check (games_per_round between 1 and 10),
  add column current_round smallint not null default 1 check (current_round >= 1),
  add column left_round_games smallint not null default 0 check (left_round_games >= 0),
  add column right_round_games smallint not null default 0 check (right_round_games >= 0),
  add column left_rounds_won smallint not null default 0 check (left_rounds_won >= 0),
  add column right_rounds_won smallint not null default 0 check (right_rounds_won >= 0);

alter table public.matches drop constraint if exists matches_left_score_check;
alter table public.matches drop constraint if exists matches_right_score_check;
alter table public.matches add constraint matches_left_score_check check (left_score >= 0);
alter table public.matches add constraint matches_right_score_check check (right_score >= 0);

create or replace function public.tilt_room_json(p_room public.rooms)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', p_room.id, 'code', p_room.code, 'state', p_room.state,
    'round_count', p_room.round_count, 'games_per_round', p_room.games_per_round,
    'created_at', p_room.created_at, 'expires_at', p_room.expires_at)
$$;

create or replace function public.set_tilt_room_format(p_room_id uuid, p_player_id uuid, p_player_token text, p_round_count int, p_games_per_round int)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  if p_round_count not between 1 and 10 or p_games_per_round not between 1 and 10 then raise exception 'INVALID_FORMAT'; end if;
  if (select state from public.rooms where id = p_room_id) <> 'waiting' then raise exception 'ROOM_IN_PROGRESS'; end if;
  update public.rooms set round_count = p_round_count, games_per_round = p_games_per_round, updated_at = now() where id = p_room_id;
  update public.room_players set ready = false where room_id = p_room_id;
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
  select jsonb_build_object(
    'id', m.id, 'left_score', m.left_score, 'right_score', m.right_score,
    'round_count', m.round_count, 'games_per_round', m.games_per_round, 'current_round', m.current_round,
    'left_round_games', m.left_round_games, 'right_round_games', m.right_round_games,
    'left_rounds_won', m.left_rounds_won, 'right_rounds_won', m.right_rounds_won
  ) into active_match from public.matches m where m.room_id = p_room_id and m.finished_at is null order by m.started_at desc limit 1;
  return jsonb_build_object('room', public.tilt_room_json(r), 'players', player_list, 'active_match', active_match);
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
  insert into public.matches(room_id, left_player_id, right_player_id, round_count, games_per_round)
  values (p_room_id, left_id, right_id, r.round_count, r.games_per_round) returning * into m;
  update public.rooms set state = 'countdown', updated_at = now() where id = p_room_id returning * into r;
  return jsonb_build_object('room', public.tilt_room_json(r), 'match', jsonb_build_object(
    'id', m.id, 'left_score', m.left_score, 'right_score', m.right_score,
    'round_count', m.round_count, 'games_per_round', m.games_per_round, 'current_round', m.current_round,
    'left_round_games', m.left_round_games, 'right_round_games', m.right_round_games,
    'left_rounds_won', m.left_rounds_won, 'right_rounds_won', m.right_rounds_won
  ));
end $$;

create or replace function public.update_tilt_match_progress(
  p_room_id uuid, p_player_id uuid, p_player_token text, p_left_score int, p_right_score int,
  p_current_round int, p_left_round_games int, p_right_round_games int, p_left_rounds_won int, p_right_rounds_won int
)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players; m public.matches;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  select * into m from public.matches where room_id = p_room_id and finished_at is null order by started_at desc limit 1 for update;
  if m.id is null then raise exception 'MATCH_NOT_FOUND'; end if;
  if p_left_score < 0 or p_right_score < 0 or p_current_round < m.current_round or p_current_round > m.current_round + 1
    or p_left_round_games < 0 or p_right_round_games < 0 or p_left_rounds_won < m.left_rounds_won or p_right_rounds_won < m.right_rounds_won then raise exception 'INVALID_PROGRESS'; end if;
  if not ((p_left_score = m.left_score + 1 and p_right_score = m.right_score) or (p_right_score = m.right_score + 1 and p_left_score = m.left_score)) then raise exception 'INVALID_SCORE'; end if;
  update public.matches set left_score = p_left_score, right_score = p_right_score, current_round = p_current_round,
    left_round_games = p_left_round_games, right_round_games = p_right_round_games,
    left_rounds_won = p_left_rounds_won, right_rounds_won = p_right_rounds_won
  where id = m.id;
end $$;

create or replace function public.finish_tilt_match(p_room_id uuid, p_player_id uuid, p_player_token text, p_winner_side text, p_left_score int, p_right_score int)
returns void language plpgsql security definer set search_path = public as $$
declare caller public.room_players; m public.matches; expected_winner public.tilt_player_side;
begin
  caller := public.tilt_authorise(p_room_id, p_player_id, p_player_token);
  if caller.id is null or caller.side <> 'left' then raise exception 'NOT_HOST'; end if;
  select * into m from public.matches where room_id = p_room_id and finished_at is null order by started_at desc limit 1 for update;
  if m.id is null then raise exception 'MATCH_NOT_FOUND'; end if;
  if m.left_rounds_won = m.right_rounds_won or m.current_round < m.round_count then raise exception 'INVALID_RESULT'; end if;
  expected_winner := case when m.left_rounds_won > m.right_rounds_won then 'left' else 'right' end;
  if p_winner_side <> expected_winner::text or p_left_score <> m.left_score or p_right_score <> m.right_score then raise exception 'INVALID_RESULT'; end if;
  update public.matches set winner_side = expected_winner, finished_at = now() where id = m.id;
  update public.rooms set state = 'finished', updated_at = now() where id = p_room_id;
end $$;

revoke all on function public.set_tilt_room_format(uuid,uuid,text,int,int) from public, anon, authenticated;
revoke all on function public.update_tilt_match_progress(uuid,uuid,text,int,int,int,int,int,int,int) from public, anon, authenticated;
grant execute on function public.set_tilt_room_format(uuid,uuid,text,int,int),
  public.update_tilt_match_progress(uuid,uuid,text,int,int,int,int,int,int,int) to anon;
