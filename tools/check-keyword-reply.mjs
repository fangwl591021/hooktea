// Actual Worker routing and reward code; all identities, storage and network synthetic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
let routes=fs.readFileSync(new URL('tools/check-hooktea-webhook.mjs',root),'utf8');
routes=routes.replace("'../operational-alerts.js'",JSON.stringify(new URL('operational-alerts.js',root).href))
  .replaceAll('import.meta.url',JSON.stringify(new URL('tools/check-hooktea-webhook.mjs',root).href));
routes=routes.slice(0,routes.indexOf('const filter = process.argv.find'))+'\nexport {harness};';
const {harness}=await import('data:text/javascript;base64,'+Buffer.from(routes).toString('base64'));
const suite=new URL('tools/check-hooktea-regressions.mjs',root);
let prefix=fs.readFileSync(suite,'utf8').split("test('different simultaneous rewards")[0]
  .replace("'../point-service.js'",JSON.stringify(new URL('point-service.js',root).href))
  .replace("new URL('../', import.meta.url)",`new URL(${JSON.stringify(root.href)})`);
const {runtime,UID}=await import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {runtime,UID};').toString('base64'));
const event=(id='synthetic-954e')=>({type:'message',webhookEventId:id,replyToken:'synthetic-token',source:{userId:UID},message:{id,type:'text',text:'954e'}});
const settings={shop_keyword_reward_enabled:'true',shop_keyword_reward_keywords:'954e',shop_keyword_reward_points:100};
const scenarios=[];
async function check(name,body){await body();scenarios.push(name);console.log('PASS '+name);}
await check('strict routing avoids duplicate enrollment and acknowledges a slow reward',async()=>{
 let release;const gate=new Promise(r=>release=r);let checked=0;
 const h=harness({env:{HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true',HOOKTEA_KEYWORD_ONLY:'true'},reward:async()=>{await gate;return true;}});
 h.sandbox.ensureLineOnlyCrmMember=async()=>{checked++;throw Error('SYNTHETIC_IDENTITY_FAILURE');};
 const r=await h.post([event()],{drain:false});assert.equal(r.status,200);assert.equal(checked,0);
 assert.equal(h.calls.fetch.length,0);release();await Promise.all(h.pending);
 assert.equal(h.calls.reward.length,1);
});
await check('invalid source still cannot execute a reward',async()=>{
 const h=harness({env:{HOOKTEA_NEW_MEMBER_CHILD_POINTS:'true',HOOKTEA_KEYWORD_ONLY:'true'}});
 await h.post([{...event(),source:{userId:'unverified'}}]);assert.equal(h.calls.reward.length,0);
});
await check('claim identity rejection sends a fixed pending reply without a point write',async()=>{
 const h=runtime(),messages=[];
 h.sandbox.ensureFastLineCheckinMember=async()=>{throw Error('MEMBER_IDENTITY_REVIEW_REQUIRED '+UID);};
 h.sandbox.deliverKeywordRewardReply=async(_env,_uid,_token,msg)=>{messages.push(msg.text);return {ok:true,method:'reply',status:200};};
 await h.get('handleShopKeywordReward')(h.env,h.ctx,event(),settings);await h.settle();
 assert.equal(h.state.posts,0);assert.equal(messages.length,1);assert.match(messages[0],/尚待確認/);
 const d=h.values.get('KEYWORD_REWARD_LAST');assert.equal(d.confirmed,false);assert.equal(d.replyOk,true);assert.equal(d.errorCode,'MEMBER_VERIFICATION_REQUIRED');
 const retained=JSON.stringify(d);assert(!retained.includes(UID));assert(!retained.includes('synthetic-token'));assert(!retained.includes('synthetic-954e'));assert(!retained.includes('954e'));
});
await check('redelivery and a new message cannot double award the same keyword',async()=>{
 const h=runtime(),messages=[];h.sandbox.deliverKeywordRewardReply=async(_e,_u,_t,m)=>{messages.push(m.text);return {ok:true,method:'reply',status:200};};
 for(const id of ['first','first','second'])await h.get('handleShopKeywordReward')(h.env,h.ctx,event(id),settings);
 await h.settle();assert.equal(h.state.posts,1);assert.equal(h.state.balance,100);assert.match(messages[2],/已領取過/);
 assert.equal(h.values.get('KEYWORD_REWARD_LAST').duplicate,true);
});
await check('a successful credit and failed LINE reply are recorded separately',async()=>{
 const h=runtime();h.sandbox.deliverKeywordRewardReply=async()=>({ok:false,method:'reply',reply:{status:429},ambiguous:true});
 await h.get('handleShopKeywordReward')(h.env,h.ctx,event(),settings);await h.settle();
 const d=h.values.get('KEYWORD_REWARD_LAST');assert.equal(h.state.posts,1);assert.equal(d.confirmed,true);assert.equal(d.replyOk,false);assert.equal(d.replyStatus,429);assert.equal(d.ambiguous,true);
});
await check('diagnostic storage failure does not suppress the customer reply',async()=>{
 const h=runtime();let replies=0;h.sandbox.putKvJsonOnly=async()=>{throw Error('SYNTHETIC_DIAGNOSTIC_FAILURE');};
 h.sandbox.deliverKeywordRewardReply=async()=>{replies++;return {ok:true};};
 await h.get('handleShopKeywordReward')(h.env,h.ctx,event(),settings);await h.settle();assert.equal(replies,1);assert.equal(h.state.posts,1);
});
await check('no-context execution settles diagnostic writes',async()=>{
 const h=runtime();h.sandbox.deliverKeywordRewardReply=async()=>({ok:true});
 await h.get('handleShopKeywordReward')(h.env,null,event(),settings);assert.equal(h.values.get('KEYWORD_REWARD_LAST').phase,'reply_result');
});
console.log(scenarios.length+'/'+scenarios.length+' keyword reply checks passed; no real LINE or point writes.');
