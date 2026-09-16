// Preparation only: records locally admitted work, never attests a mother fence.
// This independent gate cannot activate wallets or select a point authority.
export const TRACKING_RELEASE = '20260916-write-tracking-v1';
const unavailable = code => Response.json({status:'error',code,
  message:'服務暫時無法處理，請稍後再試。'}, {status:503,headers:{
  'Retry-After':'60','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});

export async function trackCrmRequest({db,ctx,run}) {
  const id=crypto.randomUUID();
  try {
    // Admission and pause check are one SQL transaction through the trigger.
    const result=await db.prepare("INSERT INTO crm_request_leases(lease_id,release,state) VALUES(?,?,'active')")
      .bind(id,TRACKING_RELEASE).run();
    if(result.success!==true||result.meta?.changes!==1)throw Error('ADMISSION_NOT_RECORDED');
  } catch(error) {
    const paused=String(error?.message).includes('CRM_REQUESTS_PAUSED');
    console.error(JSON.stringify({event:'crm_request_admission_failed',paused}));
    return unavailable(paused?'CRM_REQUESTS_PAUSED':'CRM_REQUEST_TRACKING_UNAVAILABLE');
  }
  const pending=[];let uncertain=false;
  const trackedCtx={waitUntil(promise){
    const observed=Promise.resolve(promise).catch(()=>{uncertain=true;});
    pending.push(observed);ctx.waitUntil(observed);
  }};
  try {
    const response=await run(trackedCtx);
    if(response.status>=500)uncertain=true;
    return response;
  } catch(error) {uncertain=true;throw error;}
  finally {
    const finish=async()=>{
      let consumed=0;
      while(consumed<pending.length){const jobs=pending.slice(consumed);consumed=pending.length;await Promise.all(jobs);}
      try {
        const result=await db.prepare("UPDATE crm_request_leases SET state=?,finished_at=CURRENT_TIMESTAMP WHERE lease_id=? AND state='active'")
          .bind(uncertain?'uncertain':'done',id).run();
        if(result.success!==true||result.meta?.changes!==1)throw Error('FINISH_NOT_RECORDED');
      } catch {
        // Keep the active record. A bookkeeping outage must not replace a
        // successful checkout response and encourage a duplicate purchase.
        console.error(JSON.stringify({event:'crm_request_finish_unconfirmed',release:TRACKING_RELEASE}));
      }
    };
    ctx.waitUntil(finish());
  }
}
