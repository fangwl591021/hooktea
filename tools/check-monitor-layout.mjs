import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../line-oa-monitor.html', import.meta.url), 'utf8');
function harness() {
  const elements = new Map(), frames = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',value:'',hidden:true,scrollTop:0,scrollHeight:2000,clientHeight:500,attributes:{},classList:{toggle(){},remove(){}},setAttribute(k,v){this.attributes[k]=v;}});
    return elements.get(id);
  };
  const ctx = {state:{active:null},$:get,document:{querySelectorAll:()=>[]},requestAnimationFrame:fn=>frames.push(fn),
    esc:value=>String(value??'').replaceAll('<','&lt;'),dateText:v=>v,avatarUrl:()=>'',uidBadges:()=>'',statusClass:()=>'',statusLabel:()=>'',riskClass:()=>'',riskLabel:()=>''};
  vm.createContext(ctx);
  const source = html.slice(html.indexOf('let renderedThreadId'), html.indexOf('function avatarUrl'));
  vm.runInContext(source+'\nglobalThis.api={renderActive,chronologicalMessages,positionMessages,isAtLatest};', ctx);
  return {ctx,get,frames,api:ctx.api,flush(){while(frames.length)frames.shift()();},select(id='a',messages=[]){ctx.state.active={id,name:'測試會員',tags:[],messages};ctx.api.renderActive();}};
}
test('all constrained chat ancestors have min-height zero and a single scroll viewport',()=>{
  assert.match(html,/#thread-list, #monitor-main, #conversation-column, #messages, #analysis-panel \{ min-height: 0;/);
  assert.match(html,/#conversation-workspace[^\n]*grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(html,/#messages \{ flex: 1 1 0;/);
  assert.match(html,/id="messages" tabindex="0" role="region"/);
});
test('tools, review, notes, and analysis default collapsed without deleting existing controls',()=>{
  for(const id of ['management-tools','safety-panel','thread-editor']) assert.match(html,new RegExp('<details id="'+id+'"(?![^>]*\\bopen\\b)'));
  assert.match(html,/<aside id="analysis-panel" hidden/);
  for(const id of ['ai-self-test','analyze-top','save-thread','save-learning','create-broadcast','feedback-more','import-members']) assert.match(html,new RegExp('id="'+id+'"'));
});
test('chronological display uses a copy and does not leave old point audit after newest chat',()=>{
  const h=harness(),messages=[{text:'newest',createdAt:'2026-10-06T06:25:00Z'},{text:'audit',createdAt:'2026-09-09T02:26:00Z'},{text:'same',createdAt:'2026-10-06T06:25:00Z'}];
  const sorted=h.api.chronologicalMessages(messages);
  assert.deepEqual(Array.from(sorted,m=>m.text),['audit','newest','same']);
  assert.deepEqual(messages.map(m=>m.text),['newest','audit','same']);
  assert.equal(h.api.chronologicalMessages(null).length,0);
});
test('opening a conversation follows latest after layout frame',()=>{
  const h=harness();h.select();h.get('messages').scrollHeight=2400;h.flush();assert.equal(h.get('messages').scrollTop,2400);
});
test('refresh and tag rerender preserve older reading position',()=>{
  const h=harness();h.select();h.flush();h.get('messages').scrollTop=120;h.select();h.flush();assert.equal(h.get('messages').scrollTop,120);
});
test('a reader at bottom follows new messages and jump-latest is explicit',()=>{
  const h=harness();h.select();h.flush();h.get('messages').scrollTop=1500;h.select();h.get('messages').scrollHeight=2600;h.flush();assert.equal(h.get('messages').scrollTop,2600);
  h.get('messages').scrollTop=120;h.api.positionMessages(true,0);h.flush();assert.equal(h.get('messages').scrollTop,2600);
});
test('queued layout work from previous member never scrolls a different conversation',()=>{
  const h=harness();h.select('a');h.select('b');h.get('messages').scrollTop=130;h.frames.shift()();assert.equal(h.get('messages').scrollTop,130);
});
test('latest sorts safely and HTML text remains escaped',()=>{
  const h=harness();h.select('a',[{text:'<img onerror=evil>',createdAt:'2026-10-06T06:25:00Z'},{text:'older',createdAt:'2026-09-09T02:26:00Z'}]);
  assert(h.get('messages').innerHTML.indexOf('older')<h.get('messages').innerHTML.indexOf('&lt;img'));
  assert(!h.get('messages').innerHTML.includes('<img onerror'));
});
test('view toggles do not call API or customer reply functions',()=>{
  const code=html.slice(html.indexOf('function toggleAnalysis'),html.indexOf('document.querySelectorAll(".filter").forEach(btn => btn.addEventListener'));
  assert.doesNotMatch(code,/fetchJson|fetch\(|saveThread|backfillSignals/);
  assert.match(code,/aria-expanded/);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
