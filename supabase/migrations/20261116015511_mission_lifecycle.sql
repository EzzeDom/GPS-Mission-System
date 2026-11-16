-- Additive upgrade of 01_schema.sql; retains assign_mission for existing clients.
alter table public.missions add column release_at timestamptz not null default now();
alter table public.missions add column request_id uuid;
alter table public.missions add constraint missions_request_unique unique(created_by,request_id);
create table public.mission_events (
 id bigint generated always as identity primary key,
 mission_id uuid not null references public.missions(id) on delete cascade,
 actor_id uuid references public.profiles(id) on delete set null,
 kind text not null,
 created_at timestamptz not null default now()
);
create index mission_events_mission_idx on public.mission_events(mission_id,created_at);
alter table public.mission_events enable row level security;
revoke all on public.mission_events from anon, authenticated;
grant select on public.mission_events to authenticated;
create policy events_admin on public.mission_events for select to authenticated using ((select private.is_admin()));

create function private.is_active() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=(select auth.uid()) and active);
$$;
revoke all on function private.is_active() from public,anon,authenticated;
grant execute on function private.is_active() to authenticated;
revoke execute on function public.handle_new_user() from public,anon,authenticated;

-- Restrictive policies are ANDed with existing recipient/step policies.
create policy missions_active_release on public.missions as restrictive for select to authenticated
using ((select private.is_admin()) or ((select private.is_active()) and release_at<=now() and status<>'canceled'));
create policy recipients_active on public.mission_recipients as restrictive for select to authenticated
using ((select private.is_admin()) or (select private.is_active()));
create policy waypoints_active_accepted on public.mission_waypoints as restrictive for select to authenticated
using ((select private.is_admin()) or ((select private.is_active()) and exists(
 select 1 from public.mission_recipients r join public.missions m on m.id=r.mission_id
 where r.mission_id=mission_waypoints.mission_id and r.user_id=(select auth.uid()) and r.state in ('accepted','completed')
)));

create function private.respond_mission(p_mission_id uuid,p_accept boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_state text; v_status text; v_release timestamptz;
begin
 if auth.uid() is null or not private.is_active() or p_accept is null then raise exception 'Acceso denegado'; end if;
 select status,release_at into v_status,v_release from public.missions where id=p_mission_id for update;
 if v_status is distinct from 'assigned' or v_release>now() then raise exception 'Misión no disponible'; end if;
 select state into v_state from public.mission_recipients where mission_id=p_mission_id and user_id=auth.uid() for update;
 if v_state is null then raise exception 'Acceso denegado'; end if;
 if v_state=(case when p_accept then 'accepted' else 'rejected' end) then return; end if;
 if v_state<>'pending' then raise exception 'La misión ya fue respondida'; end if;
 update public.mission_recipients set state=case when p_accept then 'accepted' else 'rejected' end where mission_id=p_mission_id and user_id=auth.uid();
 insert into public.mission_events(mission_id,actor_id,kind) values(p_mission_id,auth.uid(),case when p_accept then 'accepted' else 'rejected' end);
end; $$;
create function public.respond_mission(p_mission_id uuid,p_accept boolean) returns void
language sql security invoker set search_path='' as $$ select private.respond_mission(p_mission_id,p_accept); $$;
revoke all on function private.respond_mission(uuid,boolean),public.respond_mission(uuid,boolean) from public,anon,authenticated;
grant execute on function private.respond_mission(uuid,boolean),public.respond_mission(uuid,boolean) to authenticated;

-- Idempotent advance: expected step prevents a repeated request unlocking two stops.
-- Administrative confirmation is authoritative; handset location is not trusted as proof of arrival.
create function private.advance_recipient(p_mission_id uuid,p_user_id uuid,p_expected_step integer) returns void
language plpgsql security definer set search_path='' as $$
declare r public.mission_recipients; v_max integer;
begin
 if not private.is_admin() then raise exception 'Acceso denegado'; end if;
 perform 1 from public.missions where id=p_mission_id and status='assigned' and release_at<=now() for update;
 if not found then raise exception 'Misión no disponible'; end if;
 select * into r from public.mission_recipients where mission_id=p_mission_id and user_id=p_user_id for update;
 if r.state is distinct from 'accepted' or r.unlocked_step is distinct from p_expected_step then raise exception 'Estado o paso desactualizado'; end if;
 if not exists(select 1 from public.profiles where id=p_user_id and active) then raise exception 'Usuario inactivo'; end if;
 select max(position) into v_max from public.mission_waypoints where mission_id=p_mission_id;
 update public.mission_recipients set unlocked_step=least(r.unlocked_step+1,v_max),state=case when r.unlocked_step>=v_max then 'completed' else 'accepted' end
 where mission_id=p_mission_id and user_id=p_user_id;
 insert into public.mission_events(mission_id,actor_id,kind) values(p_mission_id,auth.uid(),'advance:'||p_user_id::text||':'||p_expected_step::text);
 if not exists(select 1 from public.mission_recipients where mission_id=p_mission_id and state not in ('completed','rejected')) then
 update public.missions set status='completed' where id=p_mission_id;
 end if;
end; $$;
create function public.advance_recipient(p_mission_id uuid,p_user_id uuid,p_expected_step integer) returns void
language sql security invoker set search_path='' as $$select private.advance_recipient(p_mission_id,p_user_id,p_expected_step);$$;
revoke all on function private.advance_recipient(uuid,uuid,integer),public.advance_recipient(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function private.advance_recipient(uuid,uuid,integer),public.advance_recipient(uuid,uuid,integer) to authenticated;

create function private.create_mission(p_title text,p_description text,p_points jsonb,p_group_ids uuid[],p_user_ids uuid[],p_all_users boolean,p_progressive boolean,p_release_at timestamptz,p_request_id uuid default gen_random_uuid())
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_labels text[]; v_point jsonb; v_pos integer:=0;
begin
 if not private.is_admin() then raise exception 'Acceso denegado'; end if;
 if p_request_id is null then raise exception 'Identificador de solicitud requerido'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request_id::text,0));
 select id into v_id from public.missions where created_by=auth.uid() and request_id=p_request_id;
 if v_id is not null then return v_id; end if;
 if p_points is null or jsonb_typeof(p_points)<>'array' then raise exception 'Recorrido inválido'; end if;
 if jsonb_array_length(p_points) not between 2 and 30 then raise exception 'Se requieren de 2 a 30 destinos'; end if;
 for v_point in select value from jsonb_array_elements(p_points) loop
  if jsonb_typeof(v_point->'latitude') is distinct from 'number' or jsonb_typeof(v_point->'longitude') is distinct from 'number'
   or (v_point->>'latitude')::double precision not between -90 and 90 or (v_point->>'longitude')::double precision not between -180 and 180 then raise exception 'Coordenadas inválidas'; end if;
  v_labels:=array_append(v_labels,v_point->>'label');
 end loop;
 v_id:=public.assign_mission(p_title,p_description,v_labels,p_group_ids,p_user_ids,p_all_users,p_progressive);
 update public.missions set release_at=coalesce(p_release_at,now()),request_id=p_request_id where id=v_id;
 for v_point in select value from jsonb_array_elements(p_points) loop
  v_pos:=v_pos+1;
  update public.mission_waypoints set latitude=(v_point->>'latitude')::double precision,longitude=(v_point->>'longitude')::double precision where mission_id=v_id and position=v_pos;
 end loop;
 insert into public.mission_events(mission_id,actor_id,kind) values(v_id,auth.uid(),'created');
 return v_id;
end; $$;
create function public.create_mission(p_title text,p_description text,p_points jsonb,p_group_ids uuid[],p_user_ids uuid[],p_all_users boolean,p_progressive boolean,p_release_at timestamptz,p_request_id uuid default gen_random_uuid())
returns uuid language sql security invoker set search_path='' as $$select private.create_mission(p_title,p_description,p_points,p_group_ids,p_user_ids,p_all_users,p_progressive,p_release_at,p_request_id);$$;
revoke all on function private.create_mission(text,text,jsonb,uuid[],uuid[],boolean,boolean,timestamptz,uuid),public.create_mission(text,text,jsonb,uuid[],uuid[],boolean,boolean,timestamptz,uuid) from public,anon,authenticated;
grant execute on function private.create_mission(text,text,jsonb,uuid[],uuid[],boolean,boolean,timestamptz,uuid),public.create_mission(text,text,jsonb,uuid[],uuid[],boolean,boolean,timestamptz,uuid) to authenticated;

create function private.set_user_active(p_user_id uuid,p_active boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not private.is_admin() or p_active is null or p_user_id=auth.uid() then raise exception 'Operación no permitida'; end if;
 update public.profiles set active=p_active where id=p_user_id;
 if not found then raise exception 'Usuario inexistente'; end if;
end;$$;
create function public.set_user_active(p_user_id uuid,p_active boolean) returns void language sql security invoker set search_path='' as $$select private.set_user_active(p_user_id,p_active);$$;
revoke all on function private.set_user_active(uuid,boolean),public.set_user_active(uuid,boolean) from public,anon,authenticated;
grant execute on function private.set_user_active(uuid,boolean),public.set_user_active(uuid,boolean) to authenticated;

do $$begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mission_recipients') then
 alter publication supabase_realtime add table public.mission_recipients;
 end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mission_events') then
 alter publication supabase_realtime add table public.mission_events;
 end if;
end;$$;

create function private.cancel_mission(p_mission_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not private.is_admin() then raise exception 'Acceso denegado'; end if;
 update public.missions set status='canceled' where id=p_mission_id and status='assigned';
 if found then insert into public.mission_events(mission_id,actor_id,kind) values(p_mission_id,auth.uid(),'canceled'); end if;
end;$$;
create function public.cancel_mission(p_mission_id uuid) returns void language sql security invoker set search_path='' as $$select private.cancel_mission(p_mission_id);$$;
revoke all on function private.cancel_mission(uuid),public.cancel_mission(uuid) from public,anon,authenticated;
grant execute on function private.cancel_mission(uuid),public.cancel_mission(uuid) to authenticated;
