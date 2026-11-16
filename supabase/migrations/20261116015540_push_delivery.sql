create table public.push_devices (
 token text primary key check(token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'),
 user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
 platform text not null check(platform in ('android','ios')),
 updated_at timestamptz not null default now()
);
create index push_devices_user_idx on public.push_devices(user_id);
alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon,authenticated;
grant select,insert,delete on public.push_devices to authenticated;
create policy devices_read on public.push_devices for select to authenticated using(user_id=(select auth.uid()));
create policy devices_insert on public.push_devices for insert to authenticated with check(user_id=(select auth.uid()) and (select private.is_active()));
create policy devices_delete on public.push_devices for delete to authenticated using(user_id=(select auth.uid()));

create table public.push_deliveries (
 id uuid primary key default gen_random_uuid(),
 mission_id uuid not null references public.missions(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 token text not null,
 state text not null default 'pending' check(state in ('pending','sending','ticket','delivered','failed','uncertain','skipped')),
 ticket_id text,
 error_code text,
 updated_at timestamptz not null default now(),
 unique(mission_id,user_id,token)
);
create index push_deliveries_state_idx on public.push_deliveries(state,updated_at);
alter table public.push_deliveries enable row level security;
revoke all on public.push_deliveries from anon,authenticated;
grant select on public.push_deliveries to authenticated;
create policy push_admin on public.push_deliveries for select to authenticated using((select private.is_admin()));
grant select,insert,update,delete on public.push_devices,public.push_deliveries to service_role;
grant select on public.profiles,public.missions,public.mission_recipients to service_role;

-- Service-only claims lock rows so simultaneous workers cannot send the same job.
create function public.claim_push_batch() returns setof public.push_deliveries
language plpgsql security invoker set search_path='' as $$
begin
 insert into public.push_deliveries(mission_id,user_id,token)
 select m.id,r.user_id,d.token from public.missions m
 join public.mission_recipients r on r.mission_id=m.id
 join public.profiles p on p.id=r.user_id and p.active
 join public.push_devices d on d.user_id=r.user_id
 where m.release_at<=now() and m.status='assigned' and r.state='pending'
 on conflict(mission_id,user_id,token) do nothing;
 update public.push_deliveries set state='uncertain',updated_at=now(),error_code='worker_interrupted'
 where state='sending' and updated_at<now()-interval '10 minutes';
 update public.push_deliveries q set state='skipped',updated_at=now()
 where q.state='pending' and not exists(
 select 1 from public.profiles p join public.mission_recipients r on r.user_id=p.id
 join public.missions m on m.id=r.mission_id join public.push_devices d on d.user_id=p.id
 where p.id=q.user_id and p.active and r.mission_id=q.mission_id and r.state='pending'
 and m.status='assigned' and m.release_at<=now() and d.token=q.token);
 return query update public.push_deliveries set state='sending',updated_at=now()
 where id in(select id from public.push_deliveries where state='pending' order by updated_at for update skip locked limit 50)
 returning *;
end;$$;
revoke all on function public.claim_push_batch() from public,anon,authenticated;
grant execute on function public.claim_push_batch() to service_role;
