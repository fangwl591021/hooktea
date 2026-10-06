import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../line-oa-monitor.html',import.meta.url),'utf8');
function harness() {
  const elements=new Map(),calls=[],timers=[],events={};
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,classList:{remove(){},add(){}},setAttribute(){}});return elements.get(id);};
  let version=0;
  const ctx={WORKER_URL:'https://mock.test',AbortSignal,Date,Map,JSON,encodeURIComponent,setTimeout:()=>{},
    state:{threads:[],active:null,editorDirty:false,authBlocked:false},$:get,
    normalizeThread:r=>({...r,tags:r.tags||[]}),normalizeAudience:r=>r.data,
    renderThreads:()=>{},renderAudience:()=>{},currentRows:()=>ctx.state.threads,
    renderActive:()=>{if(ctx.state.active)get('note').value=ctx.state.active.note;},
    loadLearningCases:async()=>{},loadSafety:async()=>{},safetyError:()=>{},
    notifyError:()=>assert.fail('background modal alert'),document:{hidden:false,addEventListener:(key,fn)=>events[key]=fn},
    window:{addEventListener:(key,fn)=>events[key]=fn},setInterval:(fn,ms)=>timers.push({fn,ms}),
    fetchJson:async(url,opts={})=>{
      calls.push({url,opts});
      if(url.includes('/audience'))return {data:{}};
      if(url.includes('/threads?'))return {data:[{id:'a',tags:['server']} ]};
      if(opts.method==='POST')return {data:{id:'a',...JSON.parse(opts.body),messages:[]}};
      const id=new URL(url).searchParams.get('id');
      return {data:{id,note:'server note',tags:['server'],messages:[{text:'message-'+(++version)}]}};
    }};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('let syncPromise'),html.indexOf('async function backfillSignals'))+'globalThis.api={loadAll,autoSync,loadThread,saveThread};',ctx);
  return {ctx,get,calls,timers,events,api:ctx.api};
}
test('startup displays list and selected chat even while audience never finishes',async()=>{
  const h=harness(),original=h.ctx.fetchJson;
  h.ctx.fetchJson=(url,opts)=>url.includes('/audience')?new Promise(()=>{}):original(url,opts);
  await h.api.loadAll(false);assert.equal(h.ctx.state.active.id,'a');assert.match(h.get('sync-status').textContent,/已更新/);
});
test('30-second timer refreshes both list and active messages with GET only',async()=>{
  const h=harness();await h.api.loadAll(false);const before=h.ctx.state.active.messages[0].text;
  assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,30000);await h.timers[0].fn();
  assert.notEqual(h.ctx.state.active.messages[0].text,before);
  assert(h.calls.filter(c=>c.url.includes('/threads?')).length===2);
  assert(h.calls.every(c=>!c.opts.method || c.opts.method==='GET'));
});
test('hidden or rejected-auth page never polls; visibility and online use same sync',async()=>{
  const h=harness();assert.equal(h.events.visibilitychange,h.api.autoSync);assert.equal(h.events.online,h.api.autoSync);
  h.ctx.document.hidden=true;await h.api.autoSync();h.ctx.document.hidden=false;h.ctx.state.authBlocked=true;await h.api.autoSync();assert.equal(h.calls.length,0);
});
test('overlapping manual and background sync share one read',async()=>{
  const h=harness(),original=h.ctx.fetchJson;let finish;
  h.ctx.fetchJson=(url,opts)=>url.includes('/threads?')?new Promise(r=>finish=()=>r({data:[]})):original(url,opts);
  const first=h.api.loadAll(),second=h.api.autoSync();assert.equal(typeof finish,'function');finish();await Promise.all([first,second]);assert.equal(h.get('sync-status').textContent.includes('已更新'),true);
});
test('polling preserves unsaved note, tags, new tag and learning draft; switching restores correct draft',async()=>{
  const h=harness();await h.api.loadAll(false);
  h.get('note').value='unsaved';h.get('new-tag').value='unfinished';h.get('learn-reply').value='draft';
  h.ctx.state.active.tags=['custom'];h.ctx.state.editorDirty=true;
  await h.api.autoSync();assert.equal(h.get('note').value,'unsaved');assert.deepEqual(Array.from(h.ctx.state.active.tags),['custom']);assert.equal(h.get('learn-reply').value,'draft');
  await h.api.loadThread('b');assert.equal(h.get('note').value,'server note');
  await h.api.loadThread('a');assert.equal(h.get('note').value,'unsaved');assert.equal(h.get('new-tag').value,'unfinished');
});
test('late reply for old selection cannot overwrite newly selected member',async()=>{
  const h=harness();let finish;
  h.ctx.fetchJson=url=>new URL(url).searchParams.get('id')==='a'?new Promise(r=>finish=r):Promise.resolve({data:{id:'b',tags:[]}});
  const first=h.api.loadThread('a');await h.api.loadThread('b');finish({data:{id:'a',tags:[]}});await first;assert.equal(h.ctx.state.active.id,'b');
});
test('failed initial conversation load retries automatically instead of remaining blank',async()=>{
  const h=harness(),original=h.ctx.fetchJson;let failed=false;
  h.ctx.fetchJson=(url,opts)=>{if(url.includes('/thread?')&&!failed){failed=true;throw Error('temporary');}return original(url,opts);};
  await assert.rejects(h.api.loadAll(false));assert.match(h.get('sync-status').textContent,/失敗/);
  await h.api.autoSync();assert.equal(h.ctx.state.active.id,'a');
});
test('failed polling retains existing data and does not send a write or alert',async()=>{
  const h=harness();await h.api.loadAll(false);const active=h.ctx.state.active;
  h.ctx.fetchJson=async()=>{throw Error('network');};await h.api.autoSync();assert.equal(h.ctx.state.active,active);assert.match(h.get('sync-status').textContent,/保留/);
});
test('save in flight suppresses background conversation reads and keeps edits typed after save started',async()=>{
  const h=harness();await h.api.loadAll(false);h.get('note').value='submitted';h.ctx.state.editorDirty=true;
  const original=h.ctx.fetchJson;let finish;
  h.ctx.fetchJson=(url,opts={})=>opts.method==='POST'?new Promise(r=>finish=r):original(url,opts);
  const saving=h.api.saveThread();h.get('note').value='new edit';
  const reads=h.calls.filter(c=>c.url.includes('/thread?')).length;await h.api.autoSync();
  assert.equal(h.calls.filter(c=>c.url.includes('/thread?')).length,reads);
  finish({data:{id:'a',note:'submitted',tags:['server']}});await saving;
  assert.equal(h.get('note').value,'new edit');assert(h.ctx.state.editorDirty);
});
test('default-open fixed editor and inline sync status remain visible without triggering AI or writes',()=>{
  assert.match(html,/<details id="thread-editor" open>/);assert.match(html,/id="sync-status" role="status"/);
  const polling=html.slice(html.indexOf('function autoSync'),html.indexOf('async function refreshNow'));
  assert.doesNotMatch(polling,/method:.*POST|backfill|ai-self-test|saveThread/);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
