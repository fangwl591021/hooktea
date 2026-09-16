// Per-account authority. A server-created R2 enrollment receipt is required;
// missing mother records never qualify existing CRM profiles as new members.
export const NEW_MEMBER_POINTS_RELEASE = '20260916-new-member-child-v1';
export const newMemberPointsEnabled = env => String(env.HOOKTEA_NEW_MEMBER_CHILD_POINTS) === 'true';

export function createNewMemberPointService({db,mother,legacyTransfers=false}) {
  const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
  const first=(sql,...args)=>stmt(sql,...args).first();
  const transfer=uid=>legacyTransfers?first('SELECT * FROM child_legacy_transfers WHERE line_uid=? OR crm_id=?',uid,uid):null;
  const fence=uid=>legacyTransfers?first('SELECT * FROM child_legacy_fences WHERE (line_uid=? OR crm_id=?) AND status=\'fenced\'',uid,uid):null;
  const wallet=async uid=>{
    const direct=await first('SELECT * FROM child_point_wallets WHERE line_uid=?',uid);
    if(direct||!legacyTransfers)return direct;
    const migrated=await transfer(uid);
    return migrated?first('SELECT * FROM child_point_wallets WHERE line_uid=?',migrated.line_uid):null;
  };
  const operation=r=>r && ({operation_id:r.operation_id,line_user_id:r.member_id,member_uid:r.member_id,
    kind:r.source_kind,amount:r.amount,reason:r.reason,status:'confirmed',authority:'child',
    mother_balance_after:r.balance_after,actor_id:r.actor_id,error_code:''});
  const publicResult=r=>({...mother.publicResult(r),authority:r?.authority||'mother'});
  function identity(uid,member) {
    const ids=[member?.lineUserId,member?.linkedLineUid,member?.lineUid,
      /^U[0-9a-f]{32}$/.test(member?.userId||'')?member.userId:''].filter(Boolean);
    if(!/^U[0-9a-f]{32}$/.test(uid||'') || !ids.length || ids.some(id=>id!==uid))throw Error('POINT_IDENTITY_CONFLICT');
  }
  async function enroll(member) {
    if(legacyTransfers&&member?.legacyMemberId) {
      const current=await account(member.lineUserId||member.linkedLineUid,member);
      if(!current)throw Error('CHILD_ENROLLMENT_INVALID');
      return current;
    }
    const uid=member?.userId;
    identity(uid,member);
    if(member.pointAuthority!=='child' || !/^new-child:[0-9a-f-]{36}$/.test(member.pointEnrollmentId||'') || member.legacyMemberId)
      throw Error('CHILD_ENROLLMENT_INVALID');
    let row=await wallet(uid);
    if(!row) {
      // INSERT SELECT avoids running legacy guards on replay after earning points.
      await stmt(`INSERT INTO child_point_wallets(member_id,line_uid,enrollment_id)
        SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM child_point_wallets WHERE line_uid=?)`,
        uid,uid,member.pointEnrollmentId,uid).run();
      row=await wallet(uid);
    }
    if(!row || row.enrollment_id!==member.pointEnrollmentId)throw Error('CHILD_ENROLLMENT_CONFLICT');
    return row;
  }
  async function account(uid,member) {
    identity(uid,member);
    const migrated=await transfer(uid),locked=await fence(uid);
    if(locked&&!migrated)throw Error('LEGACY_TRANSFER_IN_PROGRESS');
    const row=await wallet(uid);
    if(!row && member?.pointAuthority==='child')throw Error('CHILD_ENROLLMENT_INCOMPLETE');
    if(migrated) {
      if(!row||migrated.crm_id!==member.userId||member.legacyMemberId!==migrated.crm_id||
        migrated.identity_review_id!==member.crmCanonicalReviewId||
        row.enrollment_id!=='legacy-transfer:'+migrated.review_id)throw Error('POINT_IDENTITY_CONFLICT');
    } else if(row && (row.member_id!==member.userId || member.legacyMemberId ||
      (member.pointEnrollmentId && row.enrollment_id!==member.pointEnrollmentId)))throw Error('POINT_IDENTITY_CONFLICT');
    if(row?.status==='frozen')throw Error('CHILD_WALLET_FROZEN');
    return row;
  }
  async function get(id) {
    const local=await first('SELECT * FROM child_point_ledger WHERE operation_id=?',id);
    const legacy=await mother.get(id);
    if(local && legacy) {
      const review=await first('SELECT * FROM child_empty_account_reviews WHERE operation_id=?',id);
      if(!review || legacy.status!=='rejected' || legacy.error_code!=='TRANSFERRED_TO_CHILD' ||
        review.line_uid!==local.member_id || legacy.line_user_id!==local.member_id || legacy.member_uid!==local.member_id ||
        review.amount!==local.amount || legacy.amount!==local.amount || review.kind!==local.source_kind ||
        legacy.kind!==local.source_kind || review.reason!==local.reason || legacy.reason!==local.reason ||
        local.kind!=='reward' || local.business_key!==id || local.actor_id!=='review-transfer:'+review.actor_id)
        throw Error('CHILD_CROSS_LEDGER_CONFLICT');
    }
    return local?operation(local):legacy;
  }
  async function read(uid,member,options) {
    const a=await account(uid,member);
    if(!a)return mother.read(uid,member,options);
    const [current,records]=await db.batch([
      stmt('SELECT balance,status FROM child_point_wallets WHERE member_id=?',a.member_id),
      stmt('SELECT * FROM child_point_ledger WHERE member_id=? ORDER BY rowid DESC LIMIT 100',a.member_id),
    ]);
    const balance=current.results[0]?.balance;
    if(current.results[0]?.status!=='active')throw Error('CHILD_WALLET_UNAVAILABLE');
    return {balance,available:true,authority:'child',source:'child-d1',pendingCount:0,pendingBalance:0,
      legacyReviewRequired:false,reconciliationRequired:false,
      shared:{ok:true,balance,list:records.results.map(e=>({id:e.operation_id,get_point:e.amount,
        point_balance:e.balance_after,event_content:e.reason,created_at:e.created_at}))
        .concat(JSON.parse((await transfer(uid))?.history_json||'[]')).slice(0,100)}};
  }
  function command(input) {
    const {id,kind,amount,lineUid}=input;
    if(typeof id!=='string'||!id||id.length>200||!Number.isSafeInteger(amount)||!amount||
      typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)throw Error('INVALID_POINT_OPERATION');
    if(['daily_signin','keyword_reward','register','legacy_daily'].includes(kind)) {
      const prefix=(kind==='legacy_daily'?'legacy-daily':kind)+':'+lineUid;
      if(amount<=0 || (kind==='register'?id!==prefix:!id.startsWith(prefix+':')||id.length<=prefix.length+1))throw Error('CHILD_BUSINESS_KEY_REQUIRED');
      return {kind:'reward',key:id,actor:'system:'+kind};
    }
    if(kind==='huaxu_shop_checkout'&&id.startsWith('order-spend:')&&id.length>12&&amount<0)
      return {kind:'spend',key:id.slice(12),actor:'system:checkout'};
    if(kind==='order_restore'&&id.startsWith('order-restore:')&&id.length>14&&amount>0)
      return {kind:'refund',key:id.slice(14),actor:'system:refund'};
    if(kind==='admin_adjustment'&&id.startsWith('admin-adjust:')&&input.metadata?.actorId)
      return {kind:'adjustment',key:id,actor:String(input.metadata.actorId)};
    throw Error('CHILD_UNMAPPED_OPERATION');
  }
  async function submit(input,member) {
    const a=await account(input.lineUid,member);
    if(!a)return mother.submit(input,member);
    if(input.memberUid!==member.userId)throw Error('POINT_IDENTITY_CONFLICT');
    const c=command(input);
    const result=await db.batch([
      stmt(`INSERT INTO child_point_ledger(operation_id,member_id,kind,source_kind,business_key,amount,actor_id,reason,balance_after)
        SELECT ?,member_id,?,?,?,?,?,?,balance+? FROM child_point_wallets WHERE member_id=? AND NOT EXISTS(
          SELECT 1 FROM child_point_ledger WHERE operation_id=? OR (member_id=? AND kind=? AND business_key=?))`,
        input.id,c.kind,input.kind,c.key,input.amount,c.actor,input.reason,input.amount,a.member_id,input.id,a.member_id,c.kind,c.key),
      stmt('SELECT * FROM child_point_ledger WHERE operation_id=? OR (member_id=? AND kind=? AND business_key=?)',input.id,a.member_id,c.kind,c.key),
    ]);
    if(result.some(r=>r.success===false))throw Error('CHILD_WRITE_FAILED');
    const rows=result[1].results||[],r=rows[0];
    if(rows.length!==1||r.member_id!==a.member_id||r.kind!==c.kind||r.source_kind!==input.kind||r.business_key!==c.key||
      r.amount!==input.amount||r.actor_id!==c.actor||r.reason!==input.reason)throw Error('POINT_OPERATION_CONFLICT');
    return {...publicResult(operation(r)),duplicate:!result[0].meta.changes};
  }
  async function attempt(id,member) {
    const row=await get(id);
    if(!row)throw Error('POINT_OPERATION_MISSING');
    const a=await account(row.line_user_id,member);
    if(!a)return mother.attempt(id,member);
    if(row.authority!=='child')throw Error('CHILD_CROSS_LEDGER_CONFLICT');
    return publicResult(row);
  }
  async function resume(uid,member) {if(!await account(uid,member))return mother.resume(uid,member);}
  async function snapshot(uid,...args) {if(!await wallet(uid))return mother.snapshot(uid,...args);}
  async function history(member,page,perPage) {
    const a=await account(member.lineUserId||member.linkedLineUid||member.userId,member);
    if(!a)throw Error('CHILD_WALLET_UNAVAILABLE');
    const [summary,entries]=await db.batch([
      stmt('SELECT balance,(SELECT COUNT(*) FROM child_point_ledger WHERE member_id=?) total FROM child_point_wallets WHERE member_id=?',a.member_id,a.member_id),
      stmt('SELECT * FROM child_point_ledger WHERE member_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?',a.member_id,perPage,(page-1)*perPage),
    ]);
    const historic=JSON.parse((await transfer(a.line_uid))?.history_json||'[]');
    const localCount=summary.results[0].total,offset=(page-1)*perPage;
    const local=entries.results.map(e=>({id:e.operation_id,get_point:e.amount,point_balance:e.balance_after,event_content:e.reason,created_at:e.created_at}));
    const fromHistory=Math.max(0,offset-localCount);
    return {balance:summary.results[0].balance,total:localCount+historic.length,
      records:local.concat(historic.slice(fromHistory,fromHistory+Math.max(0,perPage-local.length)))};
  }
  return {enroll,wallet,fence,get,read,submit,attempt,resume,snapshot,publicResult,history};
}
