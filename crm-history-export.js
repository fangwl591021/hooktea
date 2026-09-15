// Read-only migration source access. Never invokes point-service, profile writes,
// reward resume, mother inserts, or opening-balance imports.
const uidPattern = /^U[0-9a-f]{32}$/;
const lineIds = m => [...new Set([m?.lineUserId,m?.linkedLineUid,m?.lineUid,m?.lineProfile?.userId,
  uidPattern.test(m?.userId || '') ? m.userId : ''].filter(Boolean))];
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), b=>b.toString(16).padStart(2,'0')).join('');
function admin(access) { if(access?.isAdmin !== true) throw new Error('Admin authorization required'); }
async function roster(read) {
  const rows=await read('USERS_INDEX');
  if(!Array.isArray(rows)||!rows.length||rows.some(r=>!r?.userId)||new Set(rows.map(r=>r.userId)).size!==rows.length)
    throw new Error('CRM_EXPORT_ROSTER_INVALID');
  return rows;
}
export async function exportCrmPointRoster({access,payload,read}) {
  admin(access);
  const offset=payload?.offset ?? 0;
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('CRM_EXPORT_OFFSET_INVALID');
  const rows=await roster(read),hash=await digest(rows);
  if(payload?.rosterHash && payload.rosterHash!==hash)throw new Error('CRM_EXPORT_ROSTER_CHANGED');
  const members=[];
  // Bounded per-request storage reads; keep records with no LINE for review.
  const selected=rows.slice(offset,offset+40);
  for(let start=0;start<selected.length;start+=4) {
    members.push(...await Promise.all(selected.slice(start,start+4).map(async row=>{
      const member=await read('USER_'+row.userId);
      return {crmId:row.userId,name:member?.name||member?.displayName||row.name||row.displayName||'',
        lineUids:lineIds(member),memberFound:!!member,identityMatches:member?.userId===row.userId,
        deleted:!!(member?.deleted||member?.isDeleted)};
    })));
  }
  return {members,total:rows.length,offset,nextOffset:offset+members.length<rows.length?offset+members.length:null,
    rosterHash:hash,observedAt:new Date().toISOString(),readOnly:true};
}
async function boundedJson(response,maxBytes=2*1024*1024) {
  if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('CRM_HISTORY_RESPONSE_TOO_LARGE');
  if(!response.body)throw new Error('CRM_HISTORY_EMPTY_RESPONSE');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try { while(true) {const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('CRM_HISTORY_RESPONSE_TOO_LARGE');}chunks.push(value);
  }} finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('CRM_HISTORY_INVALID_JSON');}
}
export async function exportCrmPointHistory({access,payload,read,config,fetcher=fetch}) {
  admin(access);
  const crmId=payload?.crmId,page=payload?.page??1,perPage=payload?.perPage??100;
  if(typeof crmId!=='string'||!crmId||crmId.length>200||!Number.isSafeInteger(page)||page<1||page>10000||
    !Number.isSafeInteger(perPage)||perPage<1||perPage>100)throw new Error('CRM_HISTORY_INPUT_INVALID');
  const rows=await roster(read);
  if(!rows.some(m=>m.userId===crmId))throw new Error('CRM_HISTORY_MEMBER_OUTSIDE_ROSTER');
  const member=await read('USER_'+crmId),uids=lineIds(member);
  if(!member||member.userId!==crmId)throw new Error('CRM_HISTORY_MEMBER_MISSING');
  if(uids.length!==1||!uidPattern.test(uids[0]))throw new Error('CRM_HISTORY_LINE_REVIEW_REQUIRED');
  // Export remains evidence only. Never turns an ambiguous identity into a wallet.
  const {apiKey,shopId,pointType,endpoint}=config||{};
  if(!apiKey||shopId!==35||pointType!=='system_point')throw new Error('CRM_HISTORY_SOURCE_CONFIG_INVALID');
  const url=new URL(endpoint);
  if(url.origin!=='https://aiwe.cc'||url.pathname!=='/index.php/wp-json/wetw-point/v1/query-user-point-list'||url.search)
    throw new Error('CRM_HISTORY_SOURCE_NOT_ALLOWED');
  let response;
  const sourceTimeout = AbortSignal.timeout(30000);
  try { response=await fetcher(url.toString(),{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:apiKey,LINE_user_id:uids[0],
      shop_id:shopId,point_type:pointType,page,per_page:perPage}),signal:sourceTimeout});
  } catch (error) {
    // Do not expose arbitrary upstream error text (it can contain credentials).
    if(sourceTimeout.aborted||error?.name==='TimeoutError'||error?.name==='AbortError')
      throw new Error('CRM_HISTORY_SOURCE_TIMEOUT');
    throw new Error('CRM_HISTORY_SOURCE_CONNECTION_FAILED');
  }
  if(!response.ok)throw new Error('CRM_HISTORY_SOURCE_HTTP_'+response.status);
  const data=await boundedJson(response);
  if(data?.success!==true||!Array.isArray(data?.data?.list))throw new Error('CRM_HISTORY_SOURCE_INVALID');
  if(data.data.list.length>100)throw new Error('CRM_HISTORY_PAGE_LIMIT_IGNORED');
  // Protect against accidental upstream credential echoes without truncating
  // point-history fields. Redactions are explicitly counted in the manifest.
  let redactions=0;
  const clean=value=>{
    if(typeof value==='string'&&value.includes(apiKey)){redactions++;return value.split(apiKey).join('[REDACTED]');}
    if(Array.isArray(value))return value.map(clean);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>{
      if(/token|secret|password|api[_-]?key|authorization/i.test(key)){redactions++;return false;}return true;
    }).map(([key,val])=>[key,clean(val)]));
    return value;
  };
  const records=clean(data.data.list);
  for(const row of records) {
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('CRM_HISTORY_ROW_INVALID');
    if(row.shop_id!=null&&Number(row.shop_id)!==shopId)throw new Error('CRM_HISTORY_SHOP_MISMATCH');
    if(row.point_type!=null&&row.point_type!==pointType)throw new Error('CRM_HISTORY_POINT_TYPE_MISMATCH');
    if(row.LINE_user_id!=null&&row.LINE_user_id!==uids[0])throw new Error('CRM_HISTORY_LINE_MISMATCH');
  }
  const metadata={};
  for(const [group,value] of Object.entries({root:data,data:data.data,pagination:data.data.pagination||data.pagination,
    paging:data.data.paging||data.paging,meta:data.data.meta||data.meta})) {
    if(!value||typeof value!=='object')continue;
    for(const key of ['page','current_page','per_page','total','total_count','total_records','total_pages','pages','count','has_more'])
      if(typeof value[key]==='number'||typeof value[key]==='boolean'||(typeof value[key]==='string'&&/^\d+$/.test(value[key])))
        metadata[group+'.'+key]=value[key];
  }
  const rawBalance=page===1?(data.data.point_balance??data.data.balance??records.find(r=>r.point_balance!=null)?.point_balance):null;
  const balance=rawBalance!=null&&rawBalance!==''&&Number.isSafeInteger(Number(rawBalance))&&Number(rawBalance)>=0?Number(rawBalance):null;
  return {crmId,lineUid:uids[0],shopId,pointType,page,perPage,records,metadata,balance,balanceExplicit:balance!==null,
    responseFields:Object.keys(data.data),source:'mother',readOnly:true,redactions,
    pageHash:await digest({records,metadata,balance}),observedAt:new Date().toISOString(),historyComplete:false};
}

// This UI uses the same LIFF login and server admin checks as CRM. No credential
// is exported. Downloads are local source evidence, never an import instruction.
export function renderCrmPointExportPage(liffId) {
  const safeId=JSON.stringify(String(liffId)).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HookTea 點數移轉唯讀匯出</title><style>body{font:16px system-ui;color:#23313a;max-width:960px;margin:auto;padding:24px}header{position:sticky;top:0;background:white;padding:12px 0}button,input{font:inherit;padding:10px;margin:6px 8px 6px 0}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f7;padding:16px}small{color:#667}a{color:#087a48}</style>
<header><a href="/admin.html">返回 CRM</a></header><h1>點數移轉唯讀匯出</h1>
<p>不改會員、不增扣點、不切換帳本。歷史紀錄與期初餘額分開保存。</p>
<p id="status" role="status">正在確認 LINE 登入…</p>
<button id="roster" disabled>讀取完整 CRM 名單</button><button id="all" disabled>匯出已綁 LINE 的歷史來源</button>
<div><label for="member">範例 CRM 會員編號</label><input id="member" size="34"><button id="probe" disabled>檢查範例分頁</button></div>
<button id="download" disabled>下載本次來源備份</button><pre id="result"></pre>
<small>未綁定或來源失敗者列例外。未證明分頁完整就不標為完整，不把未知餘額當零。這是唯讀盤點，尚未停寫，不能直接作為切換時的期初。</small>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script><script>
const el=id=>document.getElementById(id);let members=[],rosterHash='',busy=false;
const report={format:1,createdAt:new Date().toISOString(),readOnly:true,activationAllowed:false,members:[],histories:[],errors:[]};
function show(value){el('result').textContent=JSON.stringify(value,null,2);el('download').disabled=false;}
function controls(value){busy=value;for(const id of ['roster','probe'])el(id).disabled=value;el('all').disabled=value||!members.length;}
async function api(action,payload){const response=await fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload,idToken:liff.getIDToken(),accessToken:liff.getAccessToken()})});const json=await response.json();if(json.status!=='success')throw Error(json.message||json.error||'查詢失敗');return json.data;}
async function run(task){if(busy)return;controls(true);try{await task();}catch(e){el('status').textContent='查詢停止：'+e.message;show({error:e.message});}finally{controls(false);}}
el('roster').onclick=()=>run(async()=>{const collected=[];let offset=0,hash='';do{const r=await api('ADMIN_EXPORT_POINT_ROSTER',{offset,rosterHash:hash});hash=hash||r.rosterHash;if(hash!==r.rosterHash)throw Error('名单讀取期間已變更');collected.push(...r.members);offset=r.nextOffset;el('status').textContent='已讀取 '+collected.length+' / '+r.total+' 位會員';}while(offset!==null);members=collected;rosterHash=hash;report.members=members;report.rosterHash=hash;show({crmCount:members.length,lineBound:members.filter(m=>m.lineUids.length===1).length,readOnly:true});});
el('probe').onclick=()=>run(async()=>{const crmId=el('member').value.trim();const first=await api('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId,page:1,perPage:1});const second=await api('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId,page:2,perPage:1});const probe={crmId,pages:[first,second]};report.probe=probe;show(probe);el('status').textContent='範例查詢完成，未改動餘額。';});
function totalOf(p){const found=Object.entries(p.metadata).filter(([key])=>/\\.(total|total_count|total_records)$/.test(key)).map(([,v])=>Number(v));return found.length&&found.every(v=>Number.isSafeInteger(v)&&v>=0&&v===found[0])?found[0]:null;}
async function collect(member){const pages=[],seen=new Set(),entry={crmId:member.crmId,lineUid:member.lineUids[0],pages,historyComplete:false,activationAllowed:false};report.histories.push(entry);let count=0,total=null;for(let page=1;page<=10000;page++){const p=await api('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId:member.crmId,page,perPage:100});pages.push(p);const n=totalOf(p);if(page===1)total=n;else if(n!==total)throw Error('來源總筆數改變');for(const row of p.records){if(row.id==null||seen.has(String(row.id)))throw Error('缺少明細編號或分頁重複');seen.add(String(row.id));}count+=p.records.length;entry.recordCount=count;if(total!==null&&count>total)throw Error('明細超過來源總筆數');if(p.records.length===0||total!==null&&count===total){const head=await api('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId:member.crmId,page:1,perPage:100});const stable=head.pageHash===pages[0].pageHash;return Object.assign(entry,{headCheck:head,expectedTotal:total,stable,historyComplete:stable&&total!==null&&count===total,openingBalance:pages[0].balance});}}throw Error('超過分頁安全上限');}
el('all').onclick=()=>run(async()=>{report.histories=[];report.errors=[];let done=0;for(const member of members){if(!member.memberFound||!member.identityMatches||member.lineUids.length!==1){report.errors.push({crmId:member.crmId,reason:'會員身分待核對'});continue;}try{await collect(member);}catch(e){report.errors.push({crmId:member.crmId,reason:e.message});}done++;el('status').textContent='已查詢 '+done+' 位已綁定會員';show({attempted:done,complete:report.histories.filter(h=>h.historyComplete).length,review:report.errors.length});}report.completedAt=new Date().toISOString();el('status').textContent='唯讀來源查詢完成，尚未匯入或切換。請下載備份。';});
el('download').onclick=()=>{const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='hooktea-crm-history-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
(async()=>{try{await liff.init({liffId:${safeId}});if(!liff.isLoggedIn()){liff.login({redirectUri:location.href});return;}controls(false);el('status').textContent='LINE 已登入；每次讀取仍由伺服器核對管理員權限。';}catch(e){el('status').textContent='登入未完成：'+e.message;}})();
</script></html>`;
}
