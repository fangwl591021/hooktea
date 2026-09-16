import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
assert.match(html,/<select id="member-registration-sort" v-model="memberDateSort"/);
assert.match(html,/const memberDateSort = ref\('newest'\)/);
assert.match(html,/memberSearch, memberDateSort, showDeletedMembers, filteredMembers/);
const members=[
 {userId:'mid',name:'Tea',createdAt:'2025/2/5 下午2:00:00'},
 {userId:'missing',createdAt:''},
 {userId:'new',name:'Tea',createdAt:'2026-09-17'},
 {userId:'old',name:'Tea',createdAt:'2023-08-13'},
 {userId:'us',createdAt:'9/16/2026, 11:00:00 PM'},
 {userId:'iso',createdAt:'2026-09-17T01:00:00Z'},
 {userId:'invalid',createdAt:'2026-02-30'},
 {userId:'hiddenOld',isDeleted:true,createdAt:'2020-01-01'},
 {userId:'hiddenNew',isDeleted:true,createdAt:'2024-01-01'},
];
const before=JSON.stringify(members);
const ctx={users:{value:members},memberSearch:{value:''},memberDateSort:{value:'newest'},showDeletedMembers:{value:false},
 normalizedMemberTags:()=>[],computed:fn=>({get value(){return fn();}})};
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('const memberRegistrationDay ='),html.indexOf('const filteredAdminCourses ='))+'\nglobalThis.list=filteredMembers;globalThis.day=memberRegistrationDay;',ctx);
const ids=()=>Array.from(ctx.list.value,u=>u.userId);
assert.deepEqual(ids(),['new','iso','us','mid','old','missing','invalid']);
ctx.memberDateSort.value='oldest';assert.deepEqual(ids(),['old','mid','us','new','iso','missing','invalid']);
ctx.memberSearch.value='tea';assert.deepEqual(ids(),['old','mid','new']);
ctx.memberDateSort.value='newest';assert.deepEqual(ids(),['new','mid','old']);
ctx.memberSearch.value='';ctx.showDeletedMembers.value=true;assert.deepEqual(ids(),['hiddenNew','hiddenOld']);
ctx.memberDateSort.value='oldest';assert.deepEqual(ids(),['hiddenOld','hiddenNew']);
for(const bad of [null,undefined,'garbage','2026-13-01','2026-02-29','2/30/2026'])assert.equal(ctx.day(bad),null);
assert.equal(ctx.day('2024-02-29'),Date.UTC(2024,1,29));
assert.equal(JSON.stringify(members),before);
assert.match(html,/const rows = filteredMembers\.value/);
console.log('PASS newest/oldest, mixed date formats, stable ties, unknown dates last, search, hidden list, export ordering, no member mutations, inline syntax');
