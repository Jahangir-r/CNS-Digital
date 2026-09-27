import {state} from "../core/app-state.js";
import {$,$$,esc,api,toast,showError,can} from "../core/ui-core.js";

export function allowedRolesForActor() {
  if (can("manage_roles")) return state.roles;
  return state.roles.filter((r) => ["employee","shift_engineer"].includes(r.name));
}
export function roleOptions(selected="employee") { return allowedRolesForActor().map((r)=>`<option value="${esc(r.name)}" ${r.name===selected?"selected":""}>${esc(r.label)}</option>`).join(""); }
export async function loadRoles() {
  state.roles = await api("/api/roles");
  state.roleDrafts = {};
  $("#u-role").innerHTML = roleOptions("employee");
  renderRoles();
}
export function yesNo(v){return v?'<span class="badge badge-done">Bəli</span>':'<span class="badge badge-off">Xeyr</span>';}
const CHECKLIST_ROLE_PERMS = [
  ["view_checklists", "Yoxlama vərəqlərinə baxış"],
  ["create_checklists", "Yoxlama vərəqi yaratmaq"],
  ["edit_own_checklists", "Öz yoxlama vərəqini redaktə etmək"],
  ["manage_checklists", "Bütün yoxlama vərəqlərini idarə etmək"],
  ["manage_checklist_templates", "Yoxlama şablonlarını idarə etmək"],
  ["manage_checklist_shifts", "Növbə cədvəllərini idarə etmək"],
  ["create_reports_from_checklist", "Yoxlamadan nasazlıq yaratmaq"],
];
const ROLE_TOGGLE_PERMS=["view_all_reports","create_reports","edit_reports","delete_reports","export_import","manage_users","shift_engineer_access",...CHECKLIST_ROLE_PERMS.map(([key])=>key)];
export function roleValue(role,perm){ return state.roleDrafts[role.name]?.[perm] ?? !!role[perm]; }
export function roleDirty(name){ return !!state.roleDrafts[name] && Object.keys(state.roleDrafts[name]).length>0; }
export function permToggle(role,perm,value){
  const locked=role.name==="admin" || !can("manage_roles") || !ROLE_TOGGLE_PERMS.includes(perm);
  const actual=roleValue(role,perm);
  return `<input type="checkbox" class="role-permission-checkbox" data-roleperm="${esc(role.name)}" data-perm="${esc(perm)}" ${actual?"checked":""} ${locked?"disabled":""} aria-label="${esc(role.label)}: ${esc(perm)}" />`;
}
export function renderRoles(){
  const tb=$("#roles-table tbody"); if(!tb) return;
  tb.innerHTML=state.roles.map(r=>{
    const actions = r.name==="admin" ? '<span class="muted">Qorunan</span>' : `<div class="role-actions"><button class="icon-btn" data-editrole="${esc(r.name)}" title="Rolun adını dəyiş">✎</button><button class="icon-btn save-role ${roleDirty(r.name)?"":"is-clean"}" data-saverole="${esc(r.name)}">Yadda saxla</button></div>`;
    return `<tr><td data-label="Rol"><b>${esc(r.label)}</b>${r.name==="admin"?'<div class="role-lock-note">Qorunan rol</div>':''}</td><td data-label="Jurnal">${permToggle(r,"view_all_reports",r.view_all_reports)}</td><td data-label="Əlavə et">${permToggle(r,"create_reports",r.create_reports)}</td><td data-label="Redaktə">${permToggle(r,"edit_reports",r.edit_reports)}</td><td data-label="Sil">${permToggle(r,"delete_reports",r.delete_reports)}</td><td data-label="Excel">${permToggle(r,"export_import",r.export_import)}</td><td data-label="İstifadəçilər">${permToggle(r,"manage_users",r.manage_users)}</td><td data-label="Növbə müh.">${permToggle(r,"shift_engineer_access",r.shift_engineer_access)}</td><td data-label="Parol">${permToggle(r,"reset_password",r.reset_password)}</td><td data-label="Yoxlama hüquqları" class="checklist-role-cell"><span class="checklist-role-summary"><span>${CHECKLIST_ROLE_PERMS.filter(([key])=>roleValue(r,key)).length} / ${CHECKLIST_ROLE_PERMS.length}</span><button type="button" class="icon-btn checklist-role-menu" data-checklist-role="${esc(r.name)}" aria-label="${esc(r.label)} — Yoxlama hüquqları" aria-haspopup="dialog">⋮</button></span></td><td data-label="Əməliyyat">${actions}</td></tr>`;
  }).join("");
}
export function setRoleDraft(role, permission, enabled){
  const draft={...(state.roleDrafts[role.name]||{})};
  if(enabled===!!role[permission]) delete draft[permission]; else draft[permission]=enabled;
  if(Object.keys(draft).length) state.roleDrafts[role.name]=draft; else delete state.roleDrafts[role.name];
}
export function toggleRolePermission(btn){
  const role=state.roles.find(r=>r.name===btn.dataset.roleperm), permission=btn.dataset.perm;
  if(!role || role.name==="admin" || !can("manage_roles") || !ROLE_TOGGLE_PERMS.includes(permission)) return;
  setRoleDraft(role,permission,btn.checked);
  renderRoles();
}
let checklistRoleModalState=null;
export function openChecklistRoleModal(name){
  const role=state.roles.find(r=>r.name===name); if(!role) return;
  const locked=role.name==="admin" || !can("manage_roles");
  checklistRoleModalState={name, trigger:document.activeElement, values:Object.fromEntries(CHECKLIST_ROLE_PERMS.map(([key])=>[key,roleValue(role,key)]))};
  $("#checklist-role-name").textContent=role.label;
  $("#checklist-role-options").innerHTML=CHECKLIST_ROLE_PERMS.map(([key,label])=>`<label class="checklist-role-option"><input type="checkbox" class="role-permission-checkbox" data-checklist-role-perm="${key}" ${checklistRoleModalState.values[key]?"checked":""} ${locked?"disabled":""}>${esc(label)}</label>`).join("");
  $("#apply-checklist-role").disabled=locked;
  const modal=$("#checklist-role-modal"); modal.classList.remove("hidden"); modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open");
  modal.querySelector("button").focus();
}
export function closeChecklistRoleModal(){
  const trigger=checklistRoleModalState?.trigger;
  checklistRoleModalState=null;
  $("#checklist-role-modal").classList.add("hidden"); $("#checklist-role-modal").setAttribute("aria-hidden","true");
  document.body.classList.remove("modal-open"); trigger?.focus();
}
export function applyChecklistRoleModal(){
  const modalState=checklistRoleModalState, role=state.roles.find(r=>r.name===modalState?.name);
  if(!role || role.name==="admin" || !can("manage_roles")) return;
  CHECKLIST_ROLE_PERMS.forEach(([key])=>setRoleDraft(role,key,modalState.values[key]));
  closeChecklistRoleModal(); renderRoles();
  [...document.querySelectorAll("[data-checklist-role]")].find(el=>el.dataset.checklistRole===role.name)?.focus();
}
export function setChecklistRolePermission(permission,enabled){
  if(checklistRoleModalState) checklistRoleModalState.values[permission]=enabled;
}
export async function saveRolePermissions(name){
  const changes=state.roleDrafts[name]||{};
  if(!Object.keys(changes).length) return;
  try{
    await api(`/api/roles/${encodeURIComponent(name)}/permissions-batch`,{method:"PUT",body:JSON.stringify({permissions:changes})});
    toast("Rol hüquqları yadda saxlanıldı");
    await loadRoles();
  }catch(err){toast(err.message,"error");}
}
export function openRoleModal(role=null){
  $("#role-form").reset(); $("#role-error").classList.add("hidden");
  $("#role-name").value=role?.name||""; $("#role-label").value=role?.label||"";
  $("#role-modal-title").textContent=role?"Rolu redaktə et":"Yeni rol";
  $$('[data-role-form-perm]').forEach(cb=>{cb.checked=role?!!role[cb.dataset.roleFormPerm]:false;});
  $("#role-modal").classList.remove("hidden"); document.body.classList.add("modal-open");
}
export function closeRoleModal(){const m=$("#role-modal");if(m)m.classList.add("hidden");if($("#user-modal")?.classList.contains("hidden"))document.body.classList.remove("modal-open");}
export async function submitRole(e){
  e.preventDefault(); const name=$("#role-name").value;
  const permissions={}; $$('[data-role-form-perm]').forEach(cb=>permissions[cb.dataset.roleFormPerm]=cb.checked);
  const body={label:$("#role-label").value.trim(),permissions};
  try{
    if(name) await api(`/api/roles/${encodeURIComponent(name)}`,{method:"PUT",body:JSON.stringify(body)});
    else await api('/api/roles',{method:'POST',body:JSON.stringify(body)});
    closeRoleModal(); toast(name?"Rol yeniləndi":"Yeni rol yaradıldı"); await loadRoles();
  }catch(err){showError($("#role-error"),err.message);}
}
export async function loadUsers(){
  if(!state.roles.length) await loadRoles();
  const users=await api("/api/users");
  const userView=(u,mobile=false)=>{
    const self=u.id===state.me.id;
    const roleCell=can("manage_roles")&&!self?`<select class="role-select" data-roleuser="${u.id}">${state.roles.map(r=>`<option value="${esc(r.name)}" ${r.name===u.role?"selected":""}>${esc(r.label)}</option>`).join("")}</select>`:`<span class="badge badge-dir">${esc(u.role_label)}</span>`;
    const actions=[];
    if(self) actions.push('<span class="muted">Sizin hesab</span>');
    else {
      actions.push(`<button class="icon-btn" data-edituser="${u.id}" data-name="${esc(u.full_name)}" data-username="${esc(u.username)}" data-role="${esc(u.role)}" title="İstifadəçini redaktə et">✎</button>`);
      if(can("reset_password")) actions.push(`<button class="icon-btn" data-resetpw="${u.id}" data-name="${esc(u.full_name)}">Parol</button>`);
      actions.push(`<button class="icon-btn ${u.active?"danger":""}" data-toggle="${u.id}" data-active="${u.active}">${u.active?"Deaktiv et":"Aktiv et"}</button>`);
      actions.push(`<button class="icon-btn danger delete-user" data-deluser="${u.id}" data-name="${esc(u.full_name)}" title="Hesabı sil">✕</button>`);
    }
    const status=u.active?'<span class="badge badge-done">Aktiv</span>':'<span class="badge badge-off">Deaktiv</span>';
    return mobile?`<article class="user-mobile-card"><div class="user-mobile-main"><div class="user-mobile-name"><strong>${esc(u.full_name)}</strong>${status}</div><span class="user-mobile-login">${esc(u.username)}</span><div class="user-mobile-role">${roleCell}</div></div>${actions.length?`<div class="row-actions user-mobile-actions">${actions.join("")}</div>`:''}</article>`:`<tr><td>${u.id}</td><td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${roleCell}</td><td>${status}</td><td class="${self?'user-self-action':''}"><div class="row-actions">${actions.join("")}</div></td></tr>`;
  };
  $("#users-table tbody").innerHTML=users.map(u=>userView(u)).join("");
  $("#users-mobile-list").innerHTML=users.map(u=>userView(u,true)).join("");
}
export function openUserModal(user=null){
  $("#user-form").reset(); $("#user-error").classList.add("hidden");
  const editing=!!user;
  $("#u-id").value=editing?user.id:"";
  $("#user-modal-title").textContent=editing?"İstifadəçini redaktə et":"Yeni istifadəçi";
  $("#user-modal-kicker").textContent=editing?"EDIT ACCOUNT":"NEW ACCOUNT";
  $("#user-submit-btn").textContent=editing?"Yadda saxla":"Yarat";
  $("#u-password-label").classList.toggle("hidden",editing);
  $("#u-password").required=!editing;
  $("#u-role").innerHTML=roleOptions(editing?user.role:"employee");
  if(editing){ $("#u-name").value=user.full_name; $("#u-username").value=user.username; }
  $("#user-modal").classList.remove("hidden"); document.body.classList.add("modal-open");
}
export function closeUserModal(){ const m=$("#user-modal"); if(m) m.classList.add("hidden"); document.body.classList.remove("modal-open"); }
export async function createUser(e){
  e.preventDefault();
  const id=$("#u-id").value;
  try{
    if(id){
      await api(`/api/users/${id}`,{method:"PUT",body:JSON.stringify({full_name:$("#u-name").value,username:$("#u-username").value,role:$("#u-role").value})});
      closeUserModal(); toast("İstifadəçi yeniləndi"); await loadUsers();
    }else{
      await api("/api/users",{method:"POST",body:JSON.stringify({full_name:$("#u-name").value,username:$("#u-username").value,password:$("#u-password").value,role:$("#u-role").value})});
      closeUserModal(); toast("Hesab yaradıldı"); await loadUsers();
    }
  }catch(err){ showError($("#user-error"),err.message); }
}
