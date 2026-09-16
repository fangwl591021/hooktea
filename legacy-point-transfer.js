// Staff-triggered, per-account cutover. Source history is archival, not credit.
export const LEGACY_TRANSFER_RELEASE='20260917-reviewed-legacy-transfer-v1';
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const totalOf=p=>{
  const values=Object.entries(p.metadata||{}).filter(([k])=>/\.(total|total_count|total_records)$/.test(k)).map(([,v])=>Number(v));
  if(!values.length||!values.every(v=>Number.isSafeInteger(v)&&v>=0&&v===values[0]))throw Error('TRANSFER_HISTORY_TOTAL_UNKNOWN');
  return values[0];
};
export function createLegacyPointTransfer({db,bucket,read,historyPage,project,now=()=>Date.now()}) {
  const stmt=(q,...a)=>db.prepare(q).bind(...a),first=(q,...a)=>stmt(q,...a).first();
  async function memberFor(access,crmId) {
    if(access?.isAdmin!==true)throw Error('Admin authorization required');
    if(typeof crmId!=='string'||!/^[a-f0-9]{24}$/.test(crmId))throw Error('TRANSFER_MEMBER_INVALID');
    const member=await read('USER_'+crmId),uid=member?.lineUserId;
    if(!member||member.userId!==crmId||member.legacyMemberId!==crmId||member.isDeleted||
      !/^U[a-f0-9]{32}$/.test(uid||'')||member.linkedLineUid!==uid||
      [member.lineUid,member.lineProfile?.userId].filter(Boolean).some(x=>x!==uid)||
      member.crmBindingStatus!=='ADMIN_VERIFIED_LEGACY'||!member.crmCanonicalReviewId)throw Error('TRANSFER_IDENTITY_REVIEW_REQUIRED');
    const bind=await read('LINE_BIND_'+uid);
    if(bind?.legacyUserId!==crmId||bind.source!=='admin_verified_chat')throw Error('TRANSFER_BINDING_CHANGED');
    return member;
  }
  async function audit(member,records) {
    const uid=member.lineUserId,id=member.userId;
    for(const table of ['reward_claims','daily_signin_claims']) {
      if(await first(`SELECT id FROM ${table} WHERE (line_user_id=? OR member_uid IN (?,?)) AND status<>'claimed' LIMIT 1`,uid,uid,id))
        throw Error('TRANSFER_PENDING_REWARD');
    }
    if(await first('SELECT request_key FROM checkout_requests WHERE line_user_id=? AND response_json IS NULL LIMIT 1',uid))throw Error('TRANSFER_PENDING_CHECKOUT');
    const all=await read('ORDERS');if(!Array.isArray(all))throw Error('TRANSFER_ORDERS_UNAVAILABLE');
    const orders=all.filter(o=>[o.userId,o.memberUid,o.lineUserId,o.pointsMemberUid,o.lineProfile?.userId].some(v=>v===uid||v===id));
    for(const order of orders) {
      if(await first('SELECT order_id FROM order_action_locks WHERE order_id=?',order.orderId))throw Error('TRANSFER_ORDER_LOCKED');
      if(Number(order.pointsUsed||0)<=0)continue;
      // No inherited refund rights in this release: unresolved orders stay old.
      const amount=Number(order.pointsUsed),matching=records.filter(r=>String(r.event_content||'').includes(order.orderId));
      if(order.status!=='CANCELLED'||matching.filter(r=>Number(r.get_point)===-amount&&String(r.event_content).includes('購物車點數折抵')).length!==1||
        matching.filter(r=>Number(r.get_point)===amount&&String(r.event_content).includes('取消訂單回補')).length!==1)
        throw Error('TRANSFER_OLD_ORDER_REVIEW_REQUIRED');
    }
    return orders;
  }
  async function collect(crmId) {
    const head=await historyPage(crmId,1,100),total=totalOf(head);
    if(head.source!=='mother'||head.redactions!==0||head.balanceExplicit!==true||
      !Number.isSafeInteger(head.balance)||head.balance<0||total>1000)throw Error('TRANSFER_SOURCE_REVIEW_REQUIRED');
    const pages=[head],rows=[...head.records],ids=new Set();
    for(let page=2;rows.length<total&&page<=11;page++) {
      const p=await historyPage(crmId,page,100);
      if(totalOf(p)!==total||p.lineUid!==head.lineUid||p.shopId!==head.shopId||p.pointType!==head.pointType||p.redactions!==0||!p.records.length)throw Error('TRANSFER_HISTORY_CHANGED');
      pages.push(p);rows.push(...p.records);
    }
    for(const r of rows){if(r.id==null||ids.has(String(r.id)))throw Error('TRANSFER_HISTORY_DUPLICATE');ids.add(String(r.id));}
    if(rows.length!==total)throw Error('TRANSFER_HISTORY_INCOMPLETE');
    const repeated=await historyPage(crmId,1,100);
    if(repeated.pageHash!==head.pageHash)throw Error('TRANSFER_SOURCE_CHANGED');
    return {head,pages,rows,total,observedAt:new Date(now()).toISOString()};
  }
  async function prepare(access,crmId) {
    const member=await memberFor(access,crmId),uid=member.lineUserId;
    const prior=await first('SELECT * FROM child_legacy_transfers WHERE line_uid=?',uid);
    if(prior) {
      await project(member,prior);
      return {state:'active',crmId,lineUid:uid,balance:(await first('SELECT balance FROM child_point_wallets WHERE line_uid=?',uid)).balance,
        historyCount:prior.history_count,reviewId:prior.review_id};
    }
    // Check history/orders before pausing, so ordinary review failures do not lock use.
    const preliminary=await collect(crmId);await audit(member,preliminary.rows);
    let f=await first('SELECT * FROM child_legacy_fences WHERE line_uid=?',uid);
    if(f&&(f.crm_id!==crmId||f.identity_review_id!==member.crmCanonicalReviewId))throw Error('TRANSFER_REVIEW_CONFLICT');
    if(!f) {
      await stmt('INSERT INTO child_legacy_fences(line_uid,crm_id,review_id,identity_review_id,actor_id) VALUES(?,?,?,?,?)',
        uid,crmId,crypto.randomUUID(),member.crmCanonicalReviewId,String(access.lineUserId||access.userId||'admin')).run();
      f=await first('SELECT * FROM child_legacy_fences WHERE line_uid=?',uid);
    } else if(f.status==='released')await stmt("UPDATE child_legacy_fences SET status='fenced' WHERE line_uid=?",uid).run();
    try {
      const snapshot=await collect(crmId),orders=await audit(member,snapshot.rows);
      const current=await memberFor(access,crmId);
      if(JSON.stringify(current)!==JSON.stringify(member))throw Error('TRANSFER_PROFILE_CHANGED');
      const oldPoints=await read('POINTS_'+crmId),uidPoints=await read('POINTS_'+uid);
      const source={member,snapshot,orders,oldPoints,uidPoints,reviewId:f.review_id};
      const sourceHash=await sha(source),key='live/legacy-transfer-prepared/'+f.review_id+'/'+sourceHash+'.json';
      const archived=await bucket.put(key,JSON.stringify(source),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
      if(!archived) {
        const existing=await bucket.get(key);
        if(!existing||await sha(await existing.json())!==sourceHash)throw Error('TRANSFER_ARCHIVE_NOT_CONFIRMED');
      }
      return {state:'prepared',crmId,lineUid:uid,balance:snapshot.head.balance,historyCount:snapshot.total,
        sourceHash,reviewId:f.review_id,archiveKey:key,observedAt:snapshot.observedAt};
    } catch(error) {
      await stmt("UPDATE child_legacy_fences SET status='released' WHERE line_uid=?",uid).run();throw error;
    }
  }
  async function cancel(access,crmId) {
    const m=await memberFor(access,crmId);
    await stmt("UPDATE child_legacy_fences SET status='released' WHERE line_uid=?",m.lineUserId).run();
    return {state:'released',crmId};
  }
  async function activate(access,payload) {
    const member=await memberFor(access,payload.crmId),uid=member.lineUserId;
    const prior=await first('SELECT * FROM child_legacy_transfers WHERE line_uid=?',uid);
    if(prior) {
      if(prior.review_id!==payload.reviewId||prior.source_hash!==payload.sourceHash)throw Error('TRANSFER_REPLAY_CONFLICT');
      await project(member,prior);return {state:'active',crmId:member.userId,balance:(await first('SELECT balance FROM child_point_wallets WHERE line_uid=?',uid)).balance,replayed:true};
    }
    if(!/^[a-f0-9]{64}$/.test(payload.sourceHash||'')||!/^[a-f0-9-]{36}$/.test(payload.reviewId||''))throw Error('TRANSFER_RECEIPT_INVALID');
    const key='live/legacy-transfer-prepared/'+payload.reviewId+'/'+payload.sourceHash+'.json';
    const object=await bucket.get(key);if(!object)throw Error('TRANSFER_SOURCE_MISSING');
    const source=await object.json();if(await sha(source)!==payload.sourceHash)throw Error('TRANSFER_SOURCE_HASH_MISMATCH');
    const age=now()-Date.parse(source.snapshot.observedAt);
    if(age<0||age>300000||JSON.stringify(source.member)!==JSON.stringify(member))throw Error('TRANSFER_SOURCE_STALE');
    const refreshed=await collect(member.userId),head=refreshed.head;
    if(JSON.stringify(refreshed.pages.map(p=>p.pageHash))!==JSON.stringify(source.snapshot.pages.map(p=>p.pageHash)))throw Error('TRANSFER_SOURCE_CHANGED');
    if(JSON.stringify(await audit(member,source.snapshot.rows))!==JSON.stringify(source.orders))throw Error('TRANSFER_ORDERS_CHANGED');
    const t={line_uid:uid,crm_id:member.userId,review_id:payload.reviewId,identity_review_id:member.crmCanonicalReviewId,
      opening_balance:head.balance,source_hash:payload.sourceHash,archive_key:key,history_json:JSON.stringify(source.snapshot.rows),
      history_count:source.snapshot.total,observed_at:source.snapshot.observedAt};
    if(new TextEncoder().encode(t.history_json).length>500000)throw Error('TRANSFER_ARCHIVE_TOO_LARGE');
    const opening='legacy-opening:'+t.review_id;
    const statements=[stmt(`INSERT INTO child_legacy_transfers(line_uid,crm_id,review_id,identity_review_id,opening_balance,source_hash,archive_key,history_json,history_count,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,...Object.values(t)),
      stmt('INSERT INTO child_point_wallets(member_id,line_uid,enrollment_id) VALUES(?,?,?)',uid,uid,'legacy-transfer:'+t.review_id)];
    if(t.opening_balance>0)statements.push(stmt(`INSERT INTO child_point_ledger(operation_id,member_id,kind,source_kind,business_key,amount,actor_id,reason,balance_after)
      VALUES(?,?,'adjustment','legacy_opening',?,?,'system:legacy-transfer','舊帳本期初移轉（歷史明細不重複入帳）',?)`,opening,uid,opening,t.opening_balance,t.opening_balance));
    await db.batch(statements);
    await project(member,t);
    return {state:'active',crmId:member.userId,lineUid:uid,balance:t.opening_balance,historyCount:t.history_count,reviewId:t.review_id};
  }
  return {prepare,activate,cancel};
}

export function renderLegacyTransferPage(liffId) {
  const safe=JSON.stringify(String(liffId)).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HookTea 單筆舊會員移轉</title><style>body{font:16px system-ui;max-width:860px;margin:auto;padding:24px;color:#234}header{position:sticky;top:0;background:white;padding:12px}button,input{font:inherit;padding:10px;margin:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f7;padding:16px}button{cursor:pointer}</style>
<header><a href="/admin.html">返回 CRM</a></header><h1>單筆舊會員點數移轉</h1>
<p>僅限已人工核對綁定的會員。準備完成後暫停此帳戶贈扣點與折抵；其他會員不受影響。確認切換後以子站為唯一使用中的帳本，母站舊資料只保留歷史，不再同步。</p>
<p>切換時複製來源當下餘額；舊明細另存，不再加點。未完成／未退點的舊訂單必須另行核對，不能強制切換。</p>
<label for="crm">CRM 會員編號</label><input id="crm" size="30"><button id="prepare" disabled>核對並準備移轉</button>
<button id="activate" disabled>確認切換到子站</button><button id="cancel" disabled>取消準備並恢復原帳本</button>
<p id="status" role="status">確認管理員登入中…</p><pre id="result"></pre>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script><script>
const el=id=>document.getElementById(id);let prepared=null,busy=false;
const crm=new URL(location.href).searchParams.get('crmId');if(crm)el('crm').value=crm;
async function api(action,payload){const r=await fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload,idToken:liff.getIDToken(),accessToken:liff.getAccessToken()})});const j=await r.json();if(j.status!=='success')throw Error(j.message||j.error||'移轉失敗');return j.data;}
function controls(){el('prepare').disabled=busy;el('activate').disabled=busy||prepared?.state!=='prepared';el('cancel').disabled=busy||prepared?.state==='active';el('crm').disabled=busy||prepared?.state==='prepared';}
async function run(fn){if(busy)return;busy=true;controls();try{const r=await fn();el('result').textContent=JSON.stringify(r,null,2);el('status').textContent=r.state==='active'?'已切換：點數與歷史由子站提供。':r.state==='prepared'?'來源核對完成，此帳戶暫停點數異動。請確認切換，或取消準備。':'已取消准备。';}catch(e){el('status').textContent='未完成：'+e.message+'；若已有準備，請重試或取消準備，不要重複贈點。';}finally{busy=false;controls();}}
el('prepare').onclick=()=>run(async()=>{prepared=await api('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:el('crm').value.trim()});return prepared;});
el('activate').onclick=()=>run(async()=>{const r=await api('ADMIN_ACTIVATE_LEGACY_TRANSFER',prepared);prepared={...prepared,...r};return r;});
el('cancel').onclick=()=>run(async()=>{const r=await api('ADMIN_CANCEL_LEGACY_TRANSFER',{crmId:el('crm').value.trim()});prepared=null;return r;});
(async()=>{try{await liff.init({liffId:${safe}});if(!liff.isLoggedIn()){liff.login({redirectUri:location.href});return;}el('status').textContent='已登入，伺服器仍逐次核對管理員權限。';controls();}catch(e){el('status').textContent='登入未完成：'+e.message;}})();
</script></html>`;
}
