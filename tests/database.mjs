import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
create table auth.users(id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
create publication supabase_realtime;`);
await db.exec(readFileSync('supabase/01_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
await db.exec(readFileSync('supabase/migrations/20261116015511_mission_lifecycle.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/20261116015540_push_delivery.sql','utf8'));
const ids=[1,2,3,4].map(n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`);
for (const [i,id] of ids.entries()) await db.query('insert into auth.users(id,email) values($1,$2)',[id,`test${i}@example.test`]);
await db.query("update public.profiles set role='admin' where id=$1",[ids[0]]);
await db.query('update public.profiles set active=false where id=$1',[ids[3]]);
const group=(await db.query("insert into public.groups(name) values('Test group') returning id")).rows[0].id;
await db.query('insert into public.group_members(group_id,user_id) values($1,$2),($1,$3)',[group,ids[1],ids[3]]);
async function asUser(id,fn){await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);try{return await fn();}finally{await db.exec('reset role');}}
const points=JSON.stringify([{label:'Start',latitude:-34.6,longitude:-58.4},{label:'Finish',latitude:-34.7,longitude:-58.5}]);
async function create(release=null){return (await db.query('select public.create_mission($1,$2,$3,$4,$5,false,true,$6) id',['Test Mission','Instructions',points,[group],[ids[1],ids[1]],release])).rows[0].id;}
const mission=await asUser(ids[0],()=>create());
assert.equal((await db.query('select count(*)::int n from public.mission_recipients where mission_id=$1',[mission])).rows[0].n,1,'overlapping recipients deduplicated; inactive excluded');
await asUser(ids[2],async()=>{assert.equal((await db.query('select * from public.missions')).rows.length,0);await assert.rejects(()=>db.query('select public.respond_mission($1,true)',[mission]));await assert.rejects(()=>create());});
await asUser(ids[1],async()=>{
 assert.equal((await db.query('select * from public.mission_waypoints')).rows.length,0,'no coordinates before acceptance');
 await db.query('select public.respond_mission($1,true)',[mission]);
 await db.query('select public.respond_mission($1,true)',[mission]);
 assert.equal((await db.query('select * from public.mission_waypoints')).rows.length,1,'only first destination');
 await assert.rejects(()=>db.query('update public.mission_recipients set unlocked_step=99'));
 await assert.rejects(()=>db.query('select public.advance_recipient($1,$2,1)',[mission,ids[1]]));
});
assert.equal((await db.query("select count(*)::int n from public.mission_events where kind='accepted'")).rows[0].n,1,'idempotent response');
await asUser(ids[0],()=>db.query('select public.advance_recipient($1,$2,1)',[mission,ids[1]]));
await asUser(ids[0],()=>assert.rejects(()=>db.query('select public.advance_recipient($1,$2,1)',[mission,ids[1]])));
await asUser(ids[1],async()=>assert.equal((await db.query('select * from public.mission_waypoints')).rows.length,2));
await asUser(ids[0],()=>db.query('select public.set_user_active($1,false)',[ids[1]]));
await asUser(ids[1],async()=>{assert.equal((await db.query('select * from public.missions')).rows.length,0);assert.equal((await db.query('select * from public.mission_waypoints')).rows.length,0);await assert.rejects(()=>db.query('select public.respond_mission($1,true)',[mission]));});
await asUser(ids[0],()=>db.query('select public.set_user_active($1,true)',[ids[1]]));
const future=await asUser(ids[0],()=>create('2099-01-01T00:00:00Z'));
await asUser(ids[1],async()=>{assert.equal((await db.query('select * from public.missions where id=$1',[future])).rows.length,0);await assert.rejects(()=>db.query('select public.respond_mission($1,true)',[future]));});
await db.exec('set role anon');await assert.rejects(()=>db.query('select * from public.missions'));await db.exec('reset role');
console.log('PASS: recipient deduplication, inactive exclusion/revocation, outsider isolation, future embargo, acceptance idempotency, progressive destinations, write protection and admin-only advancement.');

await asUser(ids[1],()=>db.query("insert into public.push_devices(token,platform) values('ExpoPushToken[test_device]','android')"));
await asUser(ids[2],()=>assert.rejects(()=>db.query("insert into public.push_devices(token,user_id,platform) values('ExpoPushToken[spoof]',$1,'ios')",[ids[1]])));
await asUser(ids[1],()=>assert.rejects(()=>db.query('select public.claim_push_batch()')));
const due=await asUser(ids[0],()=>create());
await db.exec('set role service_role');
let claims=(await db.query('select * from public.claim_push_batch()')).rows;
assert.equal(claims.length,1,'only due pending mission sent');assert.equal(claims[0].mission_id,due);
assert.equal((await db.query('select * from public.claim_push_batch()')).rows.length,0,'claimed delivery never duplicated');
await db.exec('reset role');
await db.exec("update public.push_deliveries set updated_at=now()-interval '11 minutes'");
await db.exec('set role service_role');
assert.equal((await db.query('select * from public.claim_push_batch()')).rows.length,0,'ambiguous send not retried');
await db.exec('reset role');
assert.equal((await db.query('select state from public.push_deliveries')).rows[0].state,'uncertain');
await asUser(ids[0],()=>db.query('select public.set_user_active($1,false)',[ids[1]]));
await db.exec('set role service_role');assert.equal((await db.query('select * from public.claim_push_batch()')).rows.length,0);await db.exec('reset role');
console.log('PASS: device ownership, service-only worker, due-date filtering, unique delivery claims and uncertain-send quarantine.');


await asUser(ids[0],()=>db.query('select public.set_user_active($1,true)',[ids[1]]));
const requestId='00000000-0000-0000-0000-000000000099';
const retryCreate=()=>db.query('select public.create_mission($1,$2,$3,$4,$5,false,true,null,$6) id',['Retry Mission','Instructions',points,[group],[ids[1]],requestId]);
const first=await asUser(ids[0],retryCreate),second=await asUser(ids[0],retryCreate);
assert.equal(first.rows[0].id,second.rows[0].id,'create retries reuse the same mission');
await asUser(ids[0],()=>db.query('select public.cancel_mission($1)',[first.rows[0].id]));
await asUser(ids[1],async()=>{assert.equal((await db.query('select * from public.missions where id=$1',[first.rows[0].id])).rows.length,0);await assert.rejects(()=>db.query('select public.respond_mission($1,true)',[first.rows[0].id]));});
console.log('PASS: idempotent mission creation and canceled mission access.');

await db.close();
