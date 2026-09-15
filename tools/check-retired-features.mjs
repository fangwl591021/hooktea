import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const prefix = fs.readFileSync(new URL('tools/check-hooktea-regressions.mjs', root), 'utf8')
  .split("test('different simultaneous rewards")[0]
  .replace("'../point-service.js'", JSON.stringify(new URL('point-service.js', root).href))
  .replace("new URL('../', import.meta.url)", `new URL(${JSON.stringify(root.href)})`);
const {runtime, UID} = await import('data:text/javascript;base64,' + Buffer.from(prefix + '\nexport {runtime,UID};').toString('base64'));
const actions = ['CREATE_BOOKING','REGISTER','TEACHER_COMPLETE_BOOKING','TEACHER_DEDUCT_POINTS',
  'TEACHER_UPDATE_COURSE','TEACHER_DELETE_COURSE','ADMIN_BATCH_TOGGLE_SLOTS',
  'ADMIN_TRANSFER_ORDER_COURSE','ADMIN_UPDATE_COURSE','ADMIN_DELETE_COURSE',
  'ADMIN_APPROVE_TEACHER','ADMIN_REMOVE_TEACHER'];
for (const action of actions) {
  const h = runtime();
  h.sandbox.resolveAccess = async () => ({userId:UID,lineUserId:UID,hasVerifiedLineUser:true,isAdmin:true,isTeacher:true,settings:{}});
  const before = JSON.stringify([...h.values]);
  const response = await h.action(action, {targetUid:UID,amount:100});
  assert.equal(response.status,410,action);
  assert.equal((await response.json()).code,'LEGACY_FEATURE_RETIRED');
  await h.settle();
  assert.equal(JSON.stringify([...h.values]),before);
  assert.equal(h.state.posts,0);
}
console.log('PASS 12 retired actions reject before writes');
const h = runtime();
const order = {orderId:'historical',teacherUid:UID,amount:100};
assert.equal(await h.get('deductTeacherCommissionForOrder')(h.env,h.ctx,order,UID,'Test',()=>{throw new Error('unexpected charge');}),order);
for (const source of ['teacher_commission','teacher_deduct','slot_open']) {
  await assert.rejects(h.sandbox.worker.updatePoints(h.env,h.ctx,UID,-1,'Test',{source}),/LEGACY_FEATURE_RETIRED/);
}
assert.equal(h.state.posts,0);
console.log('PASS indirect commissions and three low-level charge sources blocked');
for (const action of ['GET_USER_POINTS','GET_COURSES','REGISTER_USER','BUY_PRODUCT']) assert.equal(h.get('isRetiredHookTeaAction')(action),false);
assert.equal((await (await h.action('GET_USER_POINTS')).json()).status,'success');
console.log('PASS member point read preserved');
