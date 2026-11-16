-- GPS Mission System: base independiente. Ejecutar UNA VEZ en un Supabase nuevo.
create extension if not exists pgcrypto;
create schema if not exists private;


create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Usuario',
  role text not null default 'user' check (role in ('admin','user')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 2 and 80),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members(user_id);

create table public.missions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  description text not null default '',
  status text not null default 'assigned' check (status in ('assigned','canceled','completed')),
  progressive boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.mission_recipients (
  mission_id uuid not null references public.missions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  unlocked_step integer not null default 1 check (unlocked_step >= 1),
  state text not null default 'pending' check (state in ('pending','accepted','rejected','completed')),
  assigned_at timestamptz not null default now(),
  primary key (mission_id,user_id)
);
create index mission_recipients_user_idx on public.mission_recipients(user_id);

create table public.mission_waypoints (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  position integer not null check (position >= 1),
  label text not null check (char_length(btrim(label)) > 0),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  unique (mission_id,position)
);

-- Usuarios: un perfil al crear cada cuenta. No permitir rol admin desde metadatos.
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(split_part(new.email, '@', 1), ''), 'Usuario'))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Si ya existían usuarios en este proyecto nuevo, completar sus perfiles.
insert into public.profiles(id,display_name)
select id,coalesce(nullif(split_part(email,'@',1),''),'Usuario') from auth.users
on conflict (id) do nothing;

-- Función interna para comprobar rol; evita recursión en RLS de profiles.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and active = true
  );
$$;

-- Proteger tablas expuestas a la API.
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.missions enable row level security;
alter table public.mission_recipients enable row level security;
alter table public.mission_waypoints enable row level security;

revoke all on public.profiles, public.groups, public.group_members,
  public.missions, public.mission_recipients, public.mission_waypoints
  from anon, authenticated;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, delete on public.group_members to authenticated;
grant select on public.missions, public.mission_recipients,
  public.mission_waypoints to authenticated;

grant usage on schema private to authenticated;
revoke all on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;

create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_admin()));

create policy groups_read on public.groups for select to authenticated
using ((select private.is_admin()));
create policy groups_insert on public.groups for insert to authenticated
with check ((select private.is_admin()) and created_by = (select auth.uid()));
create policy groups_update on public.groups for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy groups_delete on public.groups for delete to authenticated
using ((select private.is_admin()));

create policy members_read on public.group_members for select to authenticated
using ((select private.is_admin()));
create policy members_insert on public.group_members for insert to authenticated
with check ((select private.is_admin()));
create policy members_delete on public.group_members for delete to authenticated
using ((select private.is_admin()));

create policy recipients_read on public.mission_recipients for select to authenticated
using ((select private.is_admin()) or user_id = (select auth.uid()));

create policy missions_read on public.missions for select to authenticated
using (
  (select private.is_admin()) or exists(
    select 1 from public.mission_recipients r
    where r.mission_id = id and r.user_id = (select auth.uid())
  )
);

-- Un usuario con misión progresiva solo puede consultar puntos desbloqueados.
create policy waypoints_read on public.mission_waypoints for select to authenticated
using (
  (select private.is_admin()) or exists(
    select 1 from public.mission_recipients r
    join public.missions m on m.id = r.mission_id
    where r.mission_id = public.mission_waypoints.mission_id
      and r.user_id = (select auth.uid())
      and (m.progressive = false or public.mission_waypoints.position <= r.unlocked_step)
  )
);

-- RPC atómica: comprueba administrador, crea misión, puntos y destinatarios.
-- Estado 'assigned': asignación en BD; NO significa que se envió un push.
create function public.assign_mission(
  p_title text,
  p_description text,
  p_points text[],
  p_group_ids uuid[],
  p_user_ids uuid[],
  p_all_users boolean,
  p_progressive boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_mission uuid;
  v_count integer;
begin
  if not private.is_admin() then
    raise exception 'Permiso denegado';
  end if;
  if p_title is null or char_length(pg_catalog.btrim(p_title)) not between 3 and 120 then
    raise exception 'Título inválido (3 a 120 caracteres)';
  end if;
  if p_points is null or cardinality(p_points) not between 2 and 30
     or exists (select 1 from pg_catalog.unnest(p_points) as p(label)
                where p.label is null or pg_catalog.btrim(p.label) = '') then
    raise exception 'Se requieren entre 2 y 30 puntos con nombres válidos';
  end if;

  insert into public.missions(title, description, progressive, created_by)
  values(pg_catalog.btrim(p_title), coalesce(p_description,''),coalesce(p_progressive,true),auth.uid())
  returning id into v_mission;

  insert into public.mission_waypoints(mission_id, position, label)
  select v_mission, p.ordinality::integer, pg_catalog.btrim(p.label)
  from pg_catalog.unnest(p_points) with ordinality as p(label,ordinality);

  if coalesce(p_all_users,false) then
    insert into public.mission_recipients(mission_id,user_id)
    select v_mission,id from public.profiles where active = true;
  else
    insert into public.mission_recipients(mission_id,user_id)
    select v_mission,p.id from public.profiles p
    join (
      select gm.user_id from public.group_members gm
      where gm.group_id = any(coalesce(p_group_ids, array[]::uuid[]))
      union
      select pg_catalog.unnest(coalesce(p_user_ids,array[]::uuid[]))
    ) recipients on recipients.user_id = p.id
    where p.active = true;
  end if;

  select count(*) into v_count from public.mission_recipients where mission_id = v_mission;
  if v_count = 0 then
    raise exception 'La misión debe tener al menos un destinatario activo';
  end if;

  return v_mission;
end;
$$;

revoke all on function public.assign_mission(text,text,text[],uuid[],uuid[],boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.assign_mission(text,text,text[],uuid[],uuid[],boolean,boolean)
  to authenticated;
