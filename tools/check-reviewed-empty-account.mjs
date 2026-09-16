import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPointService} from '../point-service.js';
import {createNewMemberPointService} from '../new-member-points.js';
const require=createRequire(process.env.WRANGLER_PACKAGE||import.meta.url),{Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated");}}',compatibilityDate:'2026-04-06',d1Databases:{DB:'isolated-reviewed-empty'}});
let groups=0;const pass=s=>{groups++;console.log('PASS '+s);};
try {
 const db=await mf.getD1Database('DB');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^000[1-9]_.*\.sql$/.test(f)).sort()) {
  const sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/^--.*$/gm,'').trim();
  for(const part of sql.split(/;\s*(?=CREATE\s|INSERT\s|DROP\s)/).filter(s=>s.trim()))await db.prepare(part).run();
 }
 const uid='U'+'a'.repeat(32),id='daily_signin:'+uid+':2026-09-15',enroll='new-child:11111111-1111-4111-8111-111111111111';
 const member={userId:uid,lineUserId:uid,legacyMemberId:'',pointAuthority:'child',pointEnrollmentId:enroll};
 const input={id,lineUid:uid,memberUid:uid,kind:'daily_signin',amount:1,reason:'test pending daily'};
 const mother=createPointService({db,query:()=>{throw Error('MOTHER_FORBIDDEN');},insert:()=>{throw Error('MOTHER_FORBIDDEN');}});
 const service=createNewMemberPointService({db,mother});
 const seed=()=>db.prepare(`INSERT INTO point_operations(operation_id,line_user_id,member_uid,kind,amount,reason,status,error_code)
  VALUES(?,?,?,'daily_signin',1,?,'pending_member','user_not_found')`).bind(id,uid,uid,input.reason).run();
 const receipt=()=>db.prepare(`INSERT INTO child_empty_account_reviews(line_uid,enrollment_id,operation_id,amount,kind,reason,actor_id,evidence_json)
  VALUES(?,?,?,1,'daily_signin',?,'admin-reviewed','{"openingBalance":0,"source":"verified-crm"}')`).bind(uid,enroll,id,input.reason);
 const transfer=()=>db.batch([receipt(),db.prepare('INSERT INTO child_point_wallets(member_id,line_uid,enrollment_id) VALUES(?,?,?)').bind(uid,uid,enroll),
  db.prepare("UPDATE point_operations SET status='rejected',error_code='TRANSFERRED_TO_CHILD',updated_at=CURRENT_TIMESTAMP WHERE operation_id=?").bind(id),
  db.prepare(`INSERT INTO child_point_ledger(operation_id,member_id,kind,source_kind,business_key,amount,actor_id,reason,balance_after)
   VALUES(?,?,'reward','daily_signin',?,1,'review-transfer:admin-reviewed',?,1)`).bind(id,uid,id,input.reason)]);
 await seed();await assert.rejects(service.enroll(member),/CHILD_EXISTING_ACCOUNT_REVIEW/);pass('existing pending member cannot enroll without staff receipt');
 await db.prepare("UPDATE point_operations SET status='sending' WHERE operation_id=?").bind(id).run();
 await assert.rejects(transfer(),/EMPTY_ACCOUNT_REVIEW_CONFLICT/);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM child_empty_account_reviews').first()).n,0);pass('in-flight or uncertain state rejects the complete transaction');
 await db.prepare("UPDATE point_operations SET status='pending_member' WHERE operation_id=?").bind(id).run();
 await db.prepare('INSERT INTO point_sync_locks(line_user_id,operation_id) VALUES(?,?)').bind(uid,id).run();
 await assert.rejects(transfer(),/EMPTY_ACCOUNT_REVIEW_CONFLICT/);await db.prepare('DELETE FROM point_sync_locks WHERE line_user_id=?').bind(uid).run();pass('account lock blocks transfer');
 await transfer();assert.equal((await service.enroll(member)).balance,1);assert.equal((await service.read(uid,member)).balance,1);
 assert.equal((await service.get(id)).authority,'child');assert.equal((await service.attempt(id,member)).ok,true);
 assert.equal((await mother.get(id)).status,'rejected');assert.equal((await service.history(member,1,50)).total,1);pass('one pending point transfers once; source intent and history preserved');
 await assert.rejects(transfer());await service.attempt(id,member);assert.equal((await service.read(uid,member)).balance,1);pass('transfer retry and reward retry cannot double-credit');
 await assert.rejects(db.prepare("UPDATE point_operations SET status='sending' WHERE operation_id=?").bind(id).run(),/CHILD_AUTHORITY_REQUIRED/);
 await assert.rejects(seed(),/CHILD_AUTHORITY_REQUIRED/);
 await assert.rejects(db.prepare('DELETE FROM point_operations WHERE operation_id=?').bind(id).run(),/TRANSFER_SOURCE_IMMUTABLE/);pass('old journal cannot resume, repost or erase transferred intent');
 await service.submit({...input,id:'daily_signin:'+uid+':2026-09-16',reason:'next-day'},member);
 await service.submit({id:'order-spend:test',lineUid:uid,memberUid:uid,kind:'huaxu_shop_checkout',amount:-1,reason:'purchase'},member);
 await service.submit({id:'order-restore:test',lineUid:uid,memberUid:uid,kind:'order_restore',amount:1,reason:'refund'},member);
 assert.equal((await service.read(uid,member)).balance,2);pass('later signin, purchase redemption and refund use only child ledger');
 await assert.rejects(db.prepare("UPDATE child_empty_account_reviews SET amount=2 WHERE line_uid=?").bind(uid).run(),/IMMUTABLE/);pass('review receipt immutable');
 console.log(JSON.stringify({passed:groups,productionWrites:0,motherCalls:0}));
} finally {await mf.dispose();}
