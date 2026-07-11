-- Adds the public room directory to an existing Tilt Rally multiplayer schema.
-- Apply after 001_multiplayer.sql. This migration is safe to run again.

create or replace function public.list_tilt_rooms()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(room order by room.created_at desc), '[]'::jsonb)
  from (
    select r.code, r.created_at,
      min(p.display_name) filter (where p.side = 'left') as host_name,
      count(p.id)::int as player_count
    from public.rooms r
    join public.room_players p on p.room_id = r.id
    where r.state = 'waiting' and r.expires_at > now()
    group by r.id, r.code, r.created_at
    having count(p.id) < 2
    order by r.created_at desc
    limit 50
  ) room
$$;

revoke all on function public.list_tilt_rooms() from public, anon, authenticated;
grant execute on function public.list_tilt_rooms() to anon;
