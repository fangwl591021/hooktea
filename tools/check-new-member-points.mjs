// Actual workerd + local D1/R2/KV. All network is intercepted; no production data.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {createNewMemberPointService} from '../new-member-points.js';
import {createPointService} from '../point-service.js';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url),UID='U'+'c'.repeat(32),OTHER='U'+'d'.repeat(32),OLD='U'+'e'.repeat(32);
const bundle=await build({entryPoints:[fileURLToPath(new URL('tracked-worker.js',root))],bundle:true,write:false,format:'esm',platform:'browser'});
const network=[];
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
  r2Buckets:{'act-image':'isolated-new-member'},kvNamespaces:{ACTION_DATA:'isolated-new-member'},d1Databases:{DB:'isolated-new-member'},
  bindings:{SHOP_MODULE:'huaxu',LINE_LOGIN_CHANNEL_ID:'2007674851',SHOP_LIFF_ID:'2007674851-test',
    HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true',HOOKTEA_DAILY_SIGNIN_POINTS:'1',WP_SYNC_ENABLED:'false',
    LINE_CHANNEL_SECRET:'isolated-secret',LINE_CHANNEL_ACCESS_TOKEN:'isolated-line-token',ADMIN_PASSWORD:'isolated-admin'},
  outboundService:async request=>{
    const url=new URL(request.url);network.push(url.origin+url.pathname);
    if(url.origin==='https://api.line.me'&&url.pathname==='/oauth2/v2.1/verify')return Response.json({client_id:'2007674851',expires_in:3600});
    if(url.origin==='https://api.line.me'&&url.pathname==='/v2/profile') {
      const token=request.headers.get('authorization')||'';
      return Response.json({userId:token.includes('old')?OLD:token.match(/uid:(U[0-9a-f]{32})/)?.[1]||UID,displayName:'本機合成會員'});
    }
    if(url.origin==='https://api.line.me'&&url.pathname.startsWith('/v2/bot/profile/'))return Response.json({userId:url.pathname.split('/').pop(),displayName:'本機合成會員'});
    if(url.origin==='https://api.line.me'&&/\/v2\/bot\/message\/(reply|push)$/.test(url.pathname))return Response.json({});
    throw Error('MOTHER_OR_OTHER_NETWORK_FORBIDDEN '+url.origin+url.pathname);
  }});
let groups=0;
const pass=s=>{groups++;console.log('PASS '+s);};
try {
  const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA'),r2=await mf.getR2Bucket('act-image');
  for(const file of readdirSync(new URL('migrations/',root)).filter(f=>/^000[1-9]_.*\.sql$/.test(f)).sort()) {
    const sql=readFileSync(new URL('migrations/'+file,root),'utf8').replace(/^--.*$/gm,'').trim();
    for(const statement of sql.split(/;\s*(?=CREATE\s|INSERT\s|DROP\s)/).map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  await kv.put('SYSTEM_SETTINGS',JSON.stringify({shop_module:'huaxu',shop_liff_id:'2007674851-test',
    shop_payment_methods:'COD',shop_shipping_fee:0,shop_keyword_reward_keywords:'954e',shop_keyword_reward_points:100}));
  const old={userId:OLD,lineUserId:OLD,linkedLineUid:OLD,name:'既有待核對',registrationStatus:'pending'};
  await kv.put('USERS_INDEX',JSON.stringify([old]));await kv.put('USER_'+OLD,JSON.stringify(old));
  await kv.put('PRODUCTS',JSON.stringify([{id:'test-tea',name:'合成測試茶',price:100,pointsPrice:20,isPublished:true,status:'販賣中'}]));
  const call=(path,body={},method='POST',token='local-synthetic')=>mf.dispatchFetch('https://hooktea.test'+path,{method,
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const service=createNewMemberPointService({db,mother:createPointService({db,
    query:()=>{throw Error('MOTHER_QUERY_FORBIDDEN');},insert:()=>{throw Error('MOTHER_INSERT_FORBIDDEN');}})});
  const member=async uid=>(await (await r2.get('live/high-risk/users/'+uid+'.json')).json());
  const balance=async uid=>(await db.prepare('SELECT balance FROM child_point_wallets WHERE line_uid=?').bind(uid).first())?.balance;
  const login=await call('/api/huaxu/member');assert.equal(login.status,200,await login.clone().text());
  const initial=await login.json();assert.equal(initial.member.registrationStatus,'pending');
  assert.equal(await balance(UID),0);assert.equal((await member(UID)).pointAuthority,'child');
  await call('/api/huaxu/member');assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_point_wallets').first()).n,1);
  pass('new verified login opens one zero child wallet without mother');
  const orderBody={clientOrderKey:'isolated-checkout',items:[{id:'test-tea',quantity:1}],paymentMethod:'COD',pointsUsed:20,
    customer:{name:'本機會員',phone:'0912345678',postalCode:'100',city:'臺北市',district:'中正區',address:'合成測試路1號'}};
  const blocked=await call('/api/huaxu/orders',orderBody);assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).code,'MEMBER_REGISTRATION_REQUIRED');
  pass('pending registration blocks checkout, not wallet creation');
  const webhook=async(events)=>{
    const body=JSON.stringify({destination:'isolated',events});
    const r=await mf.dispatchFetch('https://hooktea.test/line-webhook',{method:'POST',body,headers:{
      'content-type':'application/json','x-line-signature':createHmac('sha256','isolated-secret').update(body).digest('base64')}});
    assert.equal(r.status,200,await r.clone().text());await r.text();
    // dispatchFetch includes the response, not all waitUntil tasks; poll actual DB condition outside callers.
  };
  const event=(uid,text,id)=>({type:'message',webhookEventId:id,replyToken:'isolated-'+id,source:{type:'user',userId:uid},message:{type:'text',text,id}});
  const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('TEST_BACKGROUND_TIMEOUT');};
  await webhook([{type:'follow',webhookEventId:'new-follow',replyToken:'follow',source:{type:'user',userId:OTHER}},event(UID,'954e','reward'),event(UID,'一般提問','ordinary')]);
  await until(async()=>await balance(UID)===100 && await balance(OTHER)===0);
  pass('mixed follow/activity/free-text creates local profiles, credits locally, no mother forwarding');
  await webhook([event(UID,'會員打卡','alias'),event(UID,'虎克茶簽到贈點','same-day')]);
  await until(async()=>await balance(UID)===101);
  const signin=await call('/api/huaxu/checkin');assert.equal(signin.status,200,await signin.clone().text());
  assert.equal(await balance(UID),101);
  pass('unregistered user can sign in; child and former mother keywords share the daily claim');
  const m=await member(UID);
  const reward=id=>({id:'keyword_reward:'+UID+':'+id,lineUid:UID,memberUid:UID,kind:'keyword_reward',amount:100,reason:'合成活動 '+id});
  await Promise.all([service.submit(reward('A'),m),service.submit(reward('B'),m),service.submit(reward('A'),m)]);
  assert.equal(await balance(UID),301);
  await assert.rejects(service.submit({...reward('A'),amount:200},m),/CONFLICT/);
  pass('concurrent different rewards retain both credits; duplicate/conflicting retries cannot add points');
  const spend=id=>({id:'order-spend:'+id,lineUid:UID,memberUid:UID,kind:'huaxu_shop_checkout',amount:-200,reason:'合成扣點 '+id});
  const spent=await Promise.allSettled([service.submit(spend('race1'),m),service.submit(spend('race2'),m)]);
  assert.equal(spent.filter(r=>r.status==='fulfilled').length,1);assert.equal(await balance(UID),101);
  const spendId=spent[0].status==='fulfilled'?'race1':'race2';
  const refund={id:'order-restore:'+spendId,lineUid:UID,memberUid:UID,kind:'order_restore',amount:200,reason:'合成退點'};
  await Promise.all([service.submit(refund,m),service.submit(refund,m)]);assert.equal(await balance(UID),301);
  await assert.rejects(service.submit({...refund,id:'order-restore:missing'},m),/REFUND_INVALID/);
  pass('concurrent spend cannot overdraw; refund requires original spend and happens once');
  const saved=await call('/api/huaxu/member',{profile:{name:'本機會員',phone:'0912345678',pointAuthority:'mother'}},'PUT');
  assert.equal(saved.status,200,await saved.clone().text());assert.equal((await member(UID)).pointAuthority,'child');
  const checkout=await call('/api/huaxu/orders',orderBody);assert.equal(checkout.status,200,await checkout.clone().text());
  const order=(await checkout.json()).order;assert.equal(await balance(UID),281);
  const retry=await call('/api/huaxu/orders',orderBody);assert.equal(retry.status,200);assert.equal(await balance(UID),281);
  const cancel=await call('/api/huaxu/orders/cancel',{orderId:order.orderId});assert.equal(cancel.status,200,await cancel.clone().text());
  await call('/api/huaxu/orders/cancel',{orderId:order.orderId});assert.equal(await balance(UID),301);
  pass('real Worker registration, checkout deduction, retry and cancel refund use child ledger');
  const oldLogin=await call('/api/huaxu/member',{profileOnly:true},'POST','old-token');assert.equal(oldLogin.status,200);
  assert.equal(await balance(OLD),undefined);
  assert.equal(JSON.parse(await kv.get('USER_'+OLD)).pointAuthority,undefined);
  pass('pre-existing pending CRM stays unchanged, never auto-enrolled as new');
  const action=async(action,payload={})=>(await (await call('/api',{action,payload})).json());
  const adjustment={adminPassword:'isolated-admin',uid:UID,amount:5,type:'MANUAL_ADD',reason:'合成管理調整',operationId:'test-admin'};
  assert.equal((await action('ADMIN_MANAGE_POINTS',adjustment)).status,'success');
  assert.equal((await action('ADMIN_MANAGE_POINTS',adjustment)).status,'success');
  assert.equal(await balance(UID),306);
  assert.equal((await action('ADMIN_MANAGE_POINTS',{...adjustment,type:'MANUAL_DEDUCT',operationId:'test-admin-deduct'})).status,'success');
  assert.equal(await balance(UID),301);
  const crm=await action('GET_USER_POINTS',{adminPassword:'isolated-admin',targetUid:UID});
  assert.equal(crm.data.balance,301);assert.equal(crm.data.authority,'child');
  const ledger=await action('ADMIN_GET_POINTS_LEDGER',{adminPassword:'isolated-admin'});
  assert(ledger.data.some(row=>row.logId==='admin-adjust:test-admin'&&row.authority==='child'));
  const overwrite=await action('ADMIN_RECONCILE_LOCAL_POINTS',{adminPassword:'isolated-admin',targetUid:UID,targetBalance:999});
  assert.equal(overwrite.status,'error');assert.equal(await balance(UID),301);
  const denied=await action('ADMIN_MANAGE_POINTS',{...adjustment,adminPassword:'',operationId:'not-admin'});
  assert.equal(denied.status,'error');assert.equal(await balance(UID),301);
  pass('actual CRM admin add/deduct retries are idempotent; member cannot adjust points');
  const page=await action('ADMIN_EXPORT_POINT_HISTORY_PAGE',{adminPassword:'isolated-admin',crmId:UID,page:1,perPage:2});
  assert.equal(page.data.source,'child-d1');assert.equal(page.data.balance,301);assert.equal(page.data.records.length,2);
  const nextPage=await action('ADMIN_EXPORT_POINT_HISTORY_PAGE',{adminPassword:'isolated-admin',crmId:UID,page:2,perPage:2});
  assert.equal(nextPage.data.source,'child-d1');assert.notEqual(page.data.records[0].id,nextPage.data.records[0].id);
  pass('CRM full-history export pages use child records, never mother');
  const PENDING='U'+'f'.repeat(32);
  await db.prepare("INSERT INTO point_operations(operation_id,line_user_id,member_uid,kind,amount,reason,status,error_code) VALUES(?,?,?,'daily_signin',1,'舊待入帳','pending_member','user_not_found')")
    .bind('old-pending',PENDING,PENDING).run();
  const pendingLogin=await call('/api/huaxu/member',{},'POST','uid:'+PENDING);
  assert.notEqual(pendingLogin.status,200);assert.equal(await balance(PENDING),undefined);
  assert.equal((await db.prepare("SELECT status FROM point_operations WHERE operation_id='old-pending'").first()).status,'pending_member');
  pass('orphaned old pending intent blocks zero opening, preserving unresolved entry');
  const RECOVER='U'+'1'.repeat(32);
  await db.prepare(`CREATE TRIGGER test_enrollment_failure BEFORE INSERT ON child_point_wallets WHEN NEW.line_uid='${RECOVER}' BEGIN SELECT RAISE(ABORT,'TEST_D1_UNAVAILABLE'); END`).run();
  const failure=await call('/api/huaxu/member',{},'POST','uid:'+RECOVER);assert.notEqual(failure.status,200);
  const receipt=(await member(RECOVER)).pointEnrollmentId;assert.equal(await balance(RECOVER),undefined);
  await db.prepare('DROP TRIGGER test_enrollment_failure').run();
  const recovered=await call('/api/huaxu/member',{},'POST','uid:'+RECOVER);assert.equal(recovered.status,200,await recovered.clone().text());
  assert.equal((await member(RECOVER)).pointEnrollmentId,receipt);assert.equal(await balance(RECOVER),0);
  pass('interrupted R2/D1 enrollment repairs same receipt, without re-enrollment or mother fallback');
  const CORRUPT='U'+'2'.repeat(32);
  await r2.put('live/high-risk/users/'+CORRUPT+'.json','{broken');
  const corrupt=await call('/api/huaxu/member',{},'POST','uid:'+CORRUPT);assert.notEqual(corrupt.status,200);
  assert.equal(await balance(CORRUPT),undefined);
  assert.equal(await (await r2.get('live/high-risk/users/'+CORRUPT+'.json')).text(),'{broken');
  pass('unreadable old profile is not replaced or silently treated as new');
  await assert.rejects(db.prepare("INSERT INTO point_operations(operation_id,line_user_id,member_uid,kind,amount,reason,status) VALUES('bypass',?,?,'reward',1,'禁止母站寫入','queued')").bind(UID,UID).run(),/CHILD_AUTHORITY_REQUIRED/);
  await assert.rejects(service.submit({...reward('spoof'),memberUid:OTHER},m),/IDENTITY_CONFLICT/);
  pass('database rejects old mother-write path for child accounts; member ID spoof rejected');
  const points=await (await call('/api/huaxu/member')).json();
  assert.equal(points.points.balance,301);assert.equal(points.points.authority,'child');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM point_operations WHERE line_user_id=?').bind(UID).first()).n,0);
  assert(network.every(url=>url.startsWith('https://api.line.me/')),JSON.stringify(network));
  pass('member view reads the same 301 balance; zero mother calls and zero mother journal operations');
  console.log(groups+' workerd groups passed');
} finally {await mf.dispose();}
