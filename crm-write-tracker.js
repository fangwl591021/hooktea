// Preparation only: records locally admitted work, never attests a mother fence.
// This independent gate cannot activate wallets or select a point authority.
export const TRACKING_RELEASE = '20260917-write-tracking-v2';
const unavailable = code => Response.json({status:'error',code,
  message:'服務暫時無法處理，請稍後再試。'}, {status:503,headers:{
  'Retry-After':'60','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});

export async function trackCrmRequest({db,ctx,run,id=crypto.randomUUID(),onIssue=()=>{},metadata=null}) {
  try {
    // Admission and pause check are one SQL transaction through the trigger.
    const result=await db.prepare("INSERT INTO crm_request_leases(lease_id,release,state) VALUES(?,?,'active')")
      .bind(id,TRACKING_RELEASE).run();
    if(result.success!==true||result.meta?.changes!==1)throw Error('ADMISSION_NOT_RECORDED');
  } catch(error) {
    const paused=String(error?.message).includes('CRM_REQUESTS_PAUSED');
    if(!paused)onIssue({category:'tracking',code:'admission_failed'});
    console.error(JSON.stringify({event:'crm_request_admission_failed',traceId:id,paused}));
    return unavailable(paused?'CRM_REQUESTS_PAUSED':'CRM_REQUEST_TRACKING_UNAVAILABLE');
  }
  const pending=[];let uncertain=false;
  const savePhase=async(phase,status=null)=>{
    if(!metadata)return;
    try{await db.prepare('UPDATE crm_request_metadata SET phase=?,response_status=COALESCE(?,response_status),updated_at=CURRENT_TIMESTAMP WHERE lease_id=?').bind(phase,status,id).run();}
    catch{onIssue({category:'tracking',code:'finish_failed'});}
  };
  if(metadata){try{await db.prepare('INSERT INTO crm_request_metadata(lease_id,route,method,operation) VALUES(?,?,?,?)')
    .bind(id,metadata.route,metadata.method,metadata.operation).run();}
    catch{onIssue({category:'tracking',code:'finish_failed'});}}
  const trackedCtx={setOperation:async action=>{
    // No raw action, URL, query string, body, UID or member data in diagnostics.
    const allowed=new Set(['REGISTER_USER','DAILY_CHECKIN','ADMIN_MANAGE_POINTS','GET_USER_POINTS','ADMIN_GET_POINTS_LEDGER','ADMIN_GET_CRM_DETAIL',
      'ADMIN_SAVE_USER','ADMIN_PREPARE_LEGACY_TRANSFER','ADMIN_ACTIVATE_LEGACY_TRANSFER','CREATE_ADMIN_SESSION']);
    if(!metadata)return;
    try{await db.prepare('UPDATE crm_request_metadata SET operation=? WHERE lease_id=?').bind(allowed.has(action)?action:'other_rpc',id).run();}catch{}
  },waitUntil(promise){
    const observed=Promise.resolve(promise).catch(()=>{uncertain=true;onIssue({category:'background',code:'background_failed'});});
    pending.push(observed);ctx.waitUntil(observed);
  }};
  try {
    const response=await run(trackedCtx);
    if(response.status>=500)uncertain=true;
    await savePhase(pending.length?'background_pending':'handler_complete',response.status);
    return response;
  } catch(error) {uncertain=true;await savePhase('handler_failed');throw error;}
  finally {
    const finish=async()=>{
      let consumed=0;
      while(consumed<pending.length){const jobs=pending.slice(consumed);consumed=pending.length;await Promise.all(jobs);}
      try {
        const result=await db.prepare("UPDATE crm_request_leases SET state=?,finished_at=CURRENT_TIMESTAMP WHERE lease_id=? AND state='active'")
          .bind(uncertain?'uncertain':'done',id).run();
        if(result.success!==true||result.meta?.changes!==1)throw Error('FINISH_NOT_RECORDED');
        await savePhase(uncertain?'uncertain':'finished');
      } catch {
        onIssue({category:'tracking',code:'finish_failed'});
        // Keep the active record. A bookkeeping outage must not replace a
        // successful checkout response and encourage a duplicate purchase.
        console.error(JSON.stringify({event:'crm_request_finish_unconfirmed',traceId:id,release:TRACKING_RELEASE}));
      }
    };
    // Requests with no background work must finish durably before responding.
    if(pending.length)ctx.waitUntil(finish());else await finish();
  }
}
