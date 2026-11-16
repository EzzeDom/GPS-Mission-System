import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
// Invoked by a trusted scheduler with a dedicated secret, never from mobile/web.
// Keep verify_jwt=false only with this explicit independent secret check.
Deno.serve(async (request: Request) => {
  const secret = Deno.env.get('PUSH_WORKER_SECRET');
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) return new Response('Unauthorized', {status:401});
  if (request.method !== 'POST') return new Response('Method not allowed', {status:405});
  const db = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  const headers: Record<string,string> = {'Content-Type':'application/json'};
  if (Deno.env.get('EXPO_ACCESS_TOKEN')) headers.Authorization=`Bearer ${Deno.env.get('EXPO_ACCESS_TOKEN')}`;
  try {
    // A ticket means Expo accepted the job, not that a phone received it.
    const {data: tickets,error: ticketError} = await db.from('push_deliveries').select('id,ticket_id,token,user_id,updated_at').eq('state','ticket').lt('updated_at',new Date(Date.now()-15*60*1000).toISOString()).limit(100);
    if (ticketError) throw ticketError;
    if (tickets?.length) {
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts',{method:'POST',headers,body:JSON.stringify({ids:tickets.map(t=>t.ticket_id)}),signal:AbortSignal.timeout(15000)});
      if (response.ok) {
        const receipts = (await response.json()).data || {};
        for (const t of tickets) {
          const receipt=receipts[t.ticket_id];
          const expired=Date.now()-Date.parse(t.updated_at)>24*60*60*1000;
          if (!receipt && !expired) continue;
          const errorCode=receipt?.details?.error || (expired ? 'receipt_expired' : null);
          const {error}=await db.from('push_deliveries').update({state:receipt?.status==='ok' ? 'delivered' : receipt ? 'failed' : 'uncertain',error_code:errorCode,updated_at:new Date().toISOString()}).eq('id',t.id).eq('state','ticket');
          if(error) throw error;
          if(errorCode==='DeviceNotRegistered') await db.from('push_devices').delete().eq('token',t.token).eq('user_id',t.user_id);
        }
      }
    }
    const {data: jobs,error}=await db.rpc('claim_push_batch');
    if(error) throw error;
    for (const job of jobs || []) {
      // Revalidate immediately before sending; payload never contains destinations or instructions.
      const [{data:profile},{data:recipient},{data:mission},{data:device}]=await Promise.all([
        db.from('profiles').select('active').eq('id',job.user_id).single(),
        db.from('mission_recipients').select('state').eq('user_id',job.user_id).eq('mission_id',job.mission_id).single(),
        db.from('missions').select('status,release_at').eq('id',job.mission_id).single(),
        db.from('push_devices').select('token').eq('token',job.token).eq('user_id',job.user_id).single(),
      ]);
      if(!profile?.active || recipient?.state!=='pending' || mission?.status!=='assigned' || Date.parse(mission.release_at)>Date.now() || !device) {
        const {error}=await db.from('push_deliveries').update({state:'skipped',updated_at:new Date().toISOString()}).eq('id',job.id);
        if(error) throw error; continue;
      }
      let state='uncertain', ticketId=null, errorCode=null;
      try {
        const response=await fetch('https://exp.host/--/api/v2/push/send',{method:'POST',headers,signal:AbortSignal.timeout(15000),body:JSON.stringify({to:job.token,title:'TRANSMISIÓN ENTRANTE',body:'Abrí GPS Mission System para consultar tu misión.',sound:'default',channelId:'missions',priority:'high',data:{missionId:job.mission_id,deliveryId:job.id}})});
        if(response.ok){const ticket=(await response.json()).data;state=ticket?.status==='ok' && ticket.id ? 'ticket':'failed';ticketId=ticket?.id || null;errorCode=ticket?.details?.error || null;}
        else {errorCode=`http_${response.status}`;state=response.status>=500 ? 'uncertain':'failed';}
      } catch { errorCode='transport_unknown'; }
      // Never blindly retry an ambiguous send: the provider may have accepted it.
      const {error:saveError}=await db.from('push_deliveries').update({state,ticket_id:ticketId,error_code:errorCode,updated_at:new Date().toISOString()}).eq('id',job.id).eq('state','sending');
      if(saveError) throw saveError;
      if(errorCode==='DeviceNotRegistered') await db.from('push_devices').delete().eq('token',job.token).eq('user_id',job.user_id);
    }
    return Response.json({processed:jobs?.length || 0});
  } catch { return Response.json({error:'Dispatch failed; inspect delivery states before retrying.'},{status:500}); }
});
