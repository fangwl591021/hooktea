// Real local workerd/D1/R2/KV, synthetic LINE and source API; no production writes.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url);
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const root=new URL('../',import.meta.url),UID='U'+'c'.repeat(32),OLD='a'.repeat(24),OTHER='U'+'d'.repeat(32);
const bundle=await build({entryPoints:[fileURLToPath(new URL('tracked-worker.js',root))],bundle:true,write:false,format:'esm',platform:'browser'});
let motherCalls=0,motherAllowed=true,sourceChanged=false,invalidBalance=false;
const logs=[{id:2,get_point:100,point_balance:23,event_content:'取消訂單回補：old-cancel',created_at:'2026-08-17 16:39:42'},
 {id:1,get_point:-100,point_balance:-77,event_content:'購物車點數折抵：old-cancel',created_at:'2026-08-17 16:32:31'}];
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-04-06',
 r2Buckets:{'act-image':'isolated-transfer'},kvNamespaces:{ACTION_DATA:'isolated-transfer'},d1Databases:{DB:'isolated-transfer'},
 bindings:{SHOP_MODULE:'huaxu',LINE_LOGIN_CHANNEL_ID:'2007674851',SHOP_LIFF_ID:'2007674851-test',HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true',
  HOOKTEA_LEGACY_TRANSFER_ENABLED:'true',WP_SYNC_ENABLED:'true',WP_API_KEY:'synthetic-query',WP_SHOP_ID:'35',WP_POINT_TYPE:'system_point',
  WP_QUERY_POINT_URL:'https://aiwe.cc/index.php/wp-json/wetw-point/v1/query-user-point-list',
  LINE_CHANNEL_SECRET:'isolated-secret',LINE_CHANNEL_ACCESS_TOKEN:'isolated-line',ADMIN_PASSWORD:'isolated-admin',HOOKTEA_DAILY_SIGNIN_POINTS:'1'},
 outboundService:async req=>{
  const u=new URL(req.url);
  if(u.origin==='https://aiwe.cc') {
    motherCalls++;if(!motherAllowed)throw Error('MOTHER_CALL_AFTER_CUTOVER');
    assert(u.pathname.endsWith('/query-user-point-list'),'MOTHER_WRITE_FORBIDDEN');
    const p=await req.json();assert.equal(p.LINE_user_id,UID);
    return Response.json({success:true,data:{point_balance:invalidBalance?true:sourceChanged?24:23,list:logs.slice((p.page-1)*p.per_page,p.page*p.per_page),pagination:{page:p.page,per_page:p.per_page,total:2,total_pages:Math.ceil(2/p.per_page)}}});
  }
  if(u.pathname==='/oauth2/v2.1/verify')return Response.json({client_id:'2007674851',expires_in:3600});
  if(u.pathname==='/v2/profile'||u.pathname.startsWith('/v2/bot/profile/'))return Response.json({userId:UID,displayName:'Synthetic legacy'});
  if(/\/v2\/bot\/message\/(reply|push)$/.test(u.pathname))return Response.json({});
  throw Error('UNEXPECTED_NETWORK '+u.origin+u.pathname);
 }});
let groups=0;const pass=s=>console.log('PASS '+(++groups)+' '+s);
try {
 const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('ACTION_DATA'),r2=await mf.getR2Bucket('act-image');
 for(const f of readdirSync(new URL('migrations/',root)).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort())
  for(const q of readFileSync(new URL('migrations/'+f,root),'utf8').replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|DROP\s)/).filter(Boolean))await db.prepare(q).run();
 const m={userId:OLD,legacyMemberId:OLD,lineUserId:UID,linkedLineUid:UID,name:'Synthetic legacy',phone:'0912345678',
  crmBindingStatus:'ADMIN_VERIFIED_LEGACY',crmCanonicalReviewId:'synthetic-review',registrationStatus:'completed',postalCode:'100',city:'臺北市',district:'中正區',shippingAddress:'合成測試路1號'};
 const save=async(key,value)=>{await kv.put(key,JSON.stringify(value));if(key.startsWith('USER_'))await r2.put('live/high-risk/users/'+key.slice(5)+'.json',JSON.stringify(value));};
 await save('USER_'+OLD,m);await save('USERS_INDEX',[m]);await save('LINE_BIND_'+UID,{lineUserId:UID,legacyUserId:OLD,source:'admin_verified_chat',monitorThreadId:UID});
 await save('POINTS_'+OLD,{balance:2949,logs:[{logId:'legacy-import',amount:2949}]});await save('POINTS_'+UID,{balance:23,logs:[]});
 await save('SYSTEM_SETTINGS',{shop_module:'huaxu',shop_payment_methods:'COD',shop_shipping_fee:0,shop_keyword_reward_keywords:'954e',shop_keyword_reward_points:100});
 await save('PRODUCTS',[{id:'test-tea',name:'合成測試茶',price:100,pointsPrice:20,isPublished:true,status:'販賣中'}]);
 const oldOrders=[{orderId:'old-cancel',userId:UID,pointsMemberUid:UID,pointsUsed:100,status:'CANCELLED',paymentStatus:'CANCELLED'}];
 await save('ORDERS',oldOrders);
 const call=async(path,body)=>{const r=await mf.dispatchFetch('https://hooktea.test'+path,{method:'POST',headers:{authorization:'Bearer synthetic-member','content-type':'application/json'},body:JSON.stringify(body)});return{http:r.status,...await r.json()};};
 const action=(action,payload={},admin=true)=>call('/api',{action,payload:{...payload,...(admin?{adminPassword:'isolated-admin'}:{})}});
 const balance=async()=>Number((await db.prepare('SELECT balance FROM child_point_wallets WHERE line_uid=?').bind(UID).first())?.balance);
 assert.equal((await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD},false)).status,'error');
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_legacy_fences').first()).n,0);
 pass('ordinary member cannot freeze, prepare or transfer');
 invalidBalance=true;
 assert.equal((await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD})).status,'error');invalidBalance=false;
 await db.prepare("INSERT INTO daily_signin_claims(line_user_id,claim_date,status) VALUES(?,'2000-01-01','pending')").bind(UID).run();
 assert.equal((await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD})).status,'error');
 await db.prepare("DELETE FROM daily_signin_claims WHERE claim_date='2000-01-01'").run();
 await save('ORDERS',[{...oldOrders[0],status:'PENDING'}]);
 assert.equal((await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD})).status,'error');await save('ORDERS',oldOrders);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_legacy_fences').first()).n,0);
 pass('unknown source balance, pending claim and unresolved old order never freeze or activate');
 const prep=await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD});assert.equal(prep.status,'success',JSON.stringify(prep));assert.equal(prep.data.balance,23);assert.equal(prep.data.historyCount,2);
 await assert.rejects(db.prepare("INSERT INTO point_operations(operation_id,line_user_id,member_uid,kind,amount,reason,status) VALUES('bypass',?,?,'daily_signin',1,'test','queued')").bind(UID,OLD).run(),/CHILD_AUTHORITY_REQUIRED/);
 assert.equal((await action('GET_USER_POINTS',{targetUid:OLD})).status,'error');
 pass('fresh complete source and per-account fence block old writers');
 sourceChanged=true;
 assert.equal((await action('ADMIN_ACTIVATE_LEGACY_TRANSFER',prep.data)).status,'error');assert(Number.isNaN(await balance()));
 assert.equal((await action('ADMIN_CANCEL_LEGACY_TRANSFER',{crmId:OLD})).status,'success');sourceChanged=false;
 pass('changed source rejects activation; cancel releases without opening');
 const prep2=await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD});assert.equal(prep2.status,'success',JSON.stringify(prep2));
 // Force a mid-batch failure and verify neither transfer nor wallet survives.
 await db.prepare("CREATE TRIGGER test_transfer_fail BEFORE INSERT ON child_point_ledger WHEN NEW.source_kind='legacy_opening' BEGIN SELECT RAISE(ABORT,'TEST_FAILURE'); END").run();
 assert.equal((await action('ADMIN_ACTIVATE_LEGACY_TRANSFER',prep2.data)).status,'error');assert(Number.isNaN(await balance()));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_legacy_transfers').first()).n,0);await db.prepare('DROP TRIGGER test_transfer_fail').run();
 pass('opening failure atomically rolls back transfer, wallet and ledger');
 const active=await action('ADMIN_ACTIVATE_LEGACY_TRANSFER',prep2.data);assert.equal(active.status,'success',JSON.stringify(active));assert.equal(await balance(),23);
 motherAllowed=false;const cutoverCalls=motherCalls;
 const replay=await action('ADMIN_ACTIVATE_LEGACY_TRANSFER',prep2.data);assert.equal(replay.status,'success',JSON.stringify(replay));assert.equal(await balance(),23);
 assert.equal((await action('ADMIN_CANCEL_LEGACY_TRANSFER',{crmId:OLD})).status,'error');
 pass('opening credited exactly once, historical 2949 never added, active receipt cannot be cancelled');
 const customer=await call('/api/huaxu/member',{});assert.equal(customer.http,200,JSON.stringify(customer));assert.equal(customer.points.balance,23);assert.equal(customer.points.authority,'child');
 const crm=await action('GET_USER_POINTS',{targetUid:OLD});assert.equal(crm.data.balance,23);assert.equal(crm.data.authority,'child');
 const h1=await action('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId:OLD,page:1,perPage:2});const h2=await action('ADMIN_EXPORT_POINT_HISTORY_PAGE',{crmId:OLD,page:2,perPage:2});
 assert.equal(h1.data.source,'child-d1');assert.equal(h1.data.metadata['pagination.total'],3);assert.equal(h2.data.records.length,1);
 assert.equal(h1.data.records[1].id,2);assert.equal(h2.data.records[0].id,1);
 pass('actual member/CRM endpoints and paginated history read child ledger plus archived history');
 await call('/api/huaxu/orders/cancel',{orderId:'old-cancel'});assert.equal(await balance(),23);
 pass('already-cancelled legacy order cannot issue a second refund after cutover');
 const adj={uid:OLD,amount:5,type:'MANUAL_ADD',reason:'synthetic',operationId:'transfer-admin'};
 assert.equal((await action('ADMIN_MANAGE_POINTS',adj)).status,'success');await action('ADMIN_MANAGE_POINTS',adj);assert.equal(await balance(),28);
 assert.equal((await action('ADMIN_MANAGE_POINTS',{...adj,type:'MANUAL_DEDUCT',operationId:'transfer-deduct'})).status,'success');assert.equal(await balance(),23);
 const signin=await call('/api/huaxu/checkin',{});assert.equal(signin.http,200,JSON.stringify(signin));assert.equal(await balance(),24);
 await call('/api/huaxu/checkin',{});assert.equal(await balance(),24);
 const preparedAgain=await action('ADMIN_PREPARE_LEGACY_TRANSFER',{crmId:OLD});assert.equal(preparedAgain.data.balance,24);assert.equal(preparedAgain.data.state,'active');
 pass('legacy CRM add/deduct and daily checkin use child transactions with retry deduplication');
 const orderBody={clientOrderKey:'transfer-checkout',items:[{id:'test-tea',quantity:1}],paymentMethod:'COD',pointsUsed:20,customer:{name:'合成會員',phone:'0912345678',postalCode:'100',city:'臺北市',district:'中正區',address:'合成測試路1號'}};
 const order=await call('/api/huaxu/orders',orderBody);assert.equal(order.http,200,JSON.stringify(order));assert.equal(await balance(),4);
 await call('/api/huaxu/orders',orderBody);assert.equal(await balance(),4);
 const cancelled=await call('/api/huaxu/orders/cancel',{orderId:order.order.orderId});assert.equal(cancelled.http,200,JSON.stringify(cancelled));assert.equal(await balance(),24);
 await call('/api/huaxu/orders/cancel',{orderId:order.order.orderId});assert.equal(await balance(),24);
 pass('actual checkout uses child points; retry and cancellation refund exactly once');
 const body=JSON.stringify({events:[{type:'message',webhookEventId:'transfer-checkin',replyToken:'synthetic',source:{type:'user',userId:UID},message:{type:'text',text:'會員打卡',id:'transfer-checkin'}}]});
 const reply=await mf.dispatchFetch('https://hooktea.test/line-webhook',{method:'POST',body,headers:{'x-line-signature':createHmac('sha256','isolated-secret').update(body).digest('base64')}});assert.equal(reply.status,200);await reply.text();
 assert.equal(motherCalls,cutoverCalls);assert.equal(await balance(),24);
 assert.equal(JSON.parse(await kv.get('POINTS_'+OLD)).balance,2949);
 pass('migrated mother keyword is local, mother unavailable causes no fallback, original point cache retained');
 console.log(groups+' legacy-transfer workerd groups passed');
} finally {await mf.dispose();}
