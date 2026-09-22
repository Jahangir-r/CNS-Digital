import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('Rollar checklist modal isolates Cancel/Apply, uses dynamic counts and saves only via existing endpoint', async () => {
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const nodes=new Map<string,any>();
  const node=(key:string)=>{
    if(!nodes.has(key)) nodes.set(key,{innerHTML:'',textContent:'',disabled:false,classList:{add(){},remove(){}},setAttribute(){},focus(){},querySelector(){return {focus(){}};}});
    return nodes.get(key);
  };
  const calls:any[]=[];
  const context=vm.createContext({
    $:node, can:()=>true, esc:(s:any)=>String(s), toast:()=>{},
    document:{activeElement:{focus(){}},body:{classList:{add(){},remove(){}}},querySelectorAll:()=>[]},
    api:async(...args:any[])=>{calls.push(args);return [];},
  });
  vm.runInContext('let roles=[{name:"technician",label:"Texnik",view_checklists:true}],roleDrafts={};',context);
  vm.runInContext(source.slice(source.indexOf('const CHECKLIST_ROLE_PERMS'),source.indexOf('function openRoleModal')),context);
  vm.runInContext('async function loadRoles(){}',context);
  const run=(code:string)=>vm.runInContext(code,context);
  run('renderRoles()');
  assert.match(node('#roles-table tbody').innerHTML,/1 \/ 7/);
  assert.doesNotMatch(node('#roles-table tbody').innerHTML,/Bəli|Xeyr/);
  run('openChecklistRoleModal("technician"); checklistRoleModalState.values.create_checklists=true; closeChecklistRoleModal()');
  assert.equal(run('roleDirty("technician")'),false);
  run('openChecklistRoleModal("technician"); checklistRoleModalState.values.create_checklists=true; applyChecklistRoleModal()');
  assert.equal(run('roleDrafts.technician.create_checklists'),true);
  assert.match(node('#roles-table tbody').innerHTML,/2 \/ 7/);
  assert.equal(calls.length,0);
  run('toggleRolePermission({dataset:{roleperm:"technician",perm:"create_reports"},checked:true})');
  assert.equal(calls.length,0);
  await run('saveRolePermissions("technician")');
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/api/roles/technician/permissions-batch');
  assert.deepEqual(JSON.parse(calls[0][1].body),{permissions:{create_checklists:true,create_reports:true}});
  run('openChecklistRoleModal("technician"); checklistRoleModalState.values.create_checklists=false; applyChecklistRoleModal()');
  assert.equal(run('roleDrafts.technician.create_checklists'),undefined);
  run('CHECKLIST_ROLE_PERMS.push(["future_permission","Gələcək hüquq"]);renderRoles()');
  assert.match(node('#roles-table tbody').innerHTML,/1 \/ 8/);
  run('roles.push({name:"admin",label:"Admin",view_checklists:true}); openChecklistRoleModal("admin")');
  assert.equal(node('#apply-checklist-role').disabled,true);
  assert.match(node('#checklist-role-options').innerHTML,/disabled/);
  run('checklistRoleModalState.values.view_checklists=false;applyChecklistRoleModal()');
  assert.equal(run('roleDrafts.admin'),undefined);
});
