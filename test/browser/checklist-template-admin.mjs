import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/fixtures/checklist-template-browser-server.ts'],{stdio:['ignore','pipe','inherit']});
let browser;
try{
 const [out]=await once(child.stdout,'data'),config=JSON.parse(out.toString()),base=`http://127.0.0.1:${config.port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:768,height:1024}});await context.addInitScript(token=>localStorage.setItem('cns_auth_token',token),config.admin);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(base);
 await page.locator('[data-tab="checklist-templates"]').click();const root=page.locator('#tab-checklist-templates');let nativeDialogs=0;page.on('dialog',()=>nativeDialogs++);await root.locator('[data-ct="create"]').click();let createModal=root.locator('[data-ct-create-form]');await createModal.waitFor();assert.equal(nativeDialogs,0,'template creation uses no native dialog');assert.equal(await createModal.getByRole('button',{name:'İmtina'}).count(),1);assert.equal(await createModal.getByRole('button',{name:'Yarat'}).count(),1);await page.keyboard.press('Escape');await createModal.waitFor({state:'detached'});await root.locator('[data-ct="create"]').click();createModal=root.locator('[data-ct-create-form]');await createModal.locator('[data-template-code]').fill('CNS_DAILY_TECHNICAL_CHECK');await createModal.locator('[data-template-code]').press('Enter');await createModal.locator('[data-modal-error]:not([hidden])').waitFor();assert.ok((await createModal.locator('[data-modal-error]').textContent()).trim().length>0);await page.keyboard.press('Escape');
 const productionRow=root.locator('.ct-main-row').filter({hasText:'CNS_DAILY_TECHNICAL_CHECK'});await productionRow.locator('[title="Bax"]').click();
 await root.locator('[data-section]').first().waitFor();assert.equal(await root.locator('[data-section]').count(),30);assert.equal(await root.locator('[data-item]').count(),203);assert.equal(await root.locator('[data-field="required"]:checked').count(),203);assert.equal(await root.locator('.ct-review').count(),0);assert.equal(await root.getByText('Dəqiqləşdirilməlidir (unresolved)').count(),0);assert.equal(await root.getByText('Sənədin məlumatları — yalnız istinad').count(),0);
 assert.equal(await root.locator('[data-field="service_name"]').evaluateAll(nodes=>nodes.every(n=>n.value==='')),true);
 assert.ok(await root.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 const productionDownload=page.waitForEvent('download');await root.locator('[data-ct="export"]').click();assert.equal((await productionDownload).suggestedFilename(),'Checklist-Template-v1.0.xlsx');
 await root.locator('[data-ct="history"]').click();await root.locator('[data-ct="list"]').click();let draftRow=root.locator('.ct-main-row').filter({hasText:'TEST'});assert.ok(await draftRow.locator('time').textContent());assert.equal(await draftRow.locator('[data-ct="quick-edit"]').count(),1,'draft template has Edit');await draftRow.locator('[data-ct="quick-edit"]').click();
 await root.locator('[data-section]').first().locator('summary').click();assert.equal(await root.locator('[data-item]').count(),3);
 assert.equal(await root.locator('[data-field="required"]').count(),3);assert.equal(await root.locator('[data-field="active"]').count(),5);const firstItem=root.locator('[data-item]').first();assert.equal(await firstItem.locator('[data-field="technology_card"]').count(),0);await firstItem.locator('[data-tk="S1"]').check();await firstItem.locator('[data-tk="H1"]').check();
 await root.locator('[data-field="name_snapshot"]').fill('Changed draft');await root.locator('[data-ct="save"]').click();await page.waitForFunction(()=>document.querySelector('[data-ct-status]')?.textContent==='Yadda saxlanıldı');
 await root.locator('[data-ct="history"]').click();await root.locator('[data-ct="open"]').click();assert.equal(await root.locator('[data-field="name_snapshot"]').inputValue(),'Changed draft');assert.equal(await root.locator('[data-item]').first().locator('[data-tk="S1"]').isChecked(),true);assert.equal(await root.locator('[data-item]').first().locator('[data-tk="H1"]').isChecked(),true);
 const download=page.waitForEvent('download');await root.locator('[data-ct="export"]').click();assert.equal((await download).suggestedFilename(),'Checklist-Template-v1.0.xlsx');
 // Publishing here affects an isolated synthetic fixture only.
 await root.locator('[data-ct="publish"]').click();await page.waitForFunction(()=>!document.querySelector('[data-ct="publish"]'));assert.equal(await root.locator('[data-ct="save"]').count(),0);assert.equal(await root.locator('[data-field="name_snapshot"]').isDisabled(),true);
 await root.locator('[data-ct="history"]').click();
 await root.locator('[data-ct="list"]').click();
 let testRow=root.locator('.ct-main-row').filter({hasText:'TEST'}).filter({hasText:'published'});
 await testRow.locator('[data-ct="quick-use"]').click();
 assert.match(await root.locator('.cl-native-modal').textContent(),/Əvvəlki yoxlama vərəqləri dəyişməyəcək/);
 await root.locator('[data-ct="confirm-use"]').click();
 await root.locator('.ct-current').waitFor();
 testRow=root.locator('.ct-main-row:has(.ct-current)');
 await fs.mkdir('/private/tmp/cns-stage10-admin',{recursive:true});await page.screenshot({path:'/private/tmp/cns-stage10-admin/template-flat-current.png',fullPage:true});
 assert.equal(await testRow.locator('[data-ct="quick-delete"]').count(),0);
 assert.equal(await testRow.locator('[data-ct="quick-edit"]').count(),0,'current template has no Edit');
 assert.equal(await testRow.locator('[data-ct="template-edit"]').count(),0);assert.equal(await root.locator('.ct-main-row').first().locator('.ct-current').count(),1);
 assert.equal(await testRow.locator('[data-ct="quick-clone"]').count(),1);
 const viewedTemplate=await testRow.locator('[data-ct="open"]').getAttribute('data-template'),beforeView=(await(await context.request.get(base+`/api/checklist-templates/${viewedTemplate}/versions`,{headers:{'X-CNS-Token':config.admin}})).json()).length;
 await testRow.locator('[data-ct="open"]').click();await root.locator('[data-ct="history"]').click();await root.locator('[data-ct="list"]').click();
 assert.equal((await(await context.request.get(base+`/api/checklist-templates/${viewedTemplate}/versions`,{headers:{'X-CNS-Token':config.admin}})).json()).length,beforeView,'View/back never creates a version');
 testRow=root.locator('.ct-main-row:has(.ct-current)');
 await testRow.locator('[data-ct="quick-clone"]').click();
 await page.waitForFunction(()=>document.querySelector('.ct-toolbar')?.textContent.includes('v 1.1'));
 assert.equal(await root.locator('[data-ct="save"]').count(),1);
 // A disposable version is physically deleted and disappears without reload.
 const disposable=await(await context.request.post(base+'/api/checklist-templates',{headers:{'X-CNS-Token':config.admin},data:{code:'DELETE_ME',name:'Disposable'}})).json();
 await page.evaluate(()=>window.CNSTemplateAdmin.open());
 const disposableRow=root.locator('.ct-main-row').filter({hasText:'DELETE_ME'});await disposableRow.waitFor();
 await disposableRow.locator('[data-ct="quick-delete"]').click();const deleteModal=root.locator('.cl-native-modal');await deleteModal.waitFor();
 await fs.mkdir('/private/tmp/cns-delete-footer',{recursive:true});await page.screenshot({path:'/private/tmp/cns-delete-footer/delete-confirm-success.png',fullPage:true});
 await deleteModal.locator('[data-ct="confirm-delete"]').click();await deleteModal.waitFor({state:'detached'});assert.equal(await root.locator('.ct-main-row').filter({hasText:'DELETE_ME'}).count(),0);
 assert.equal((await context.request.get(base+`/api/checklist-template-versions/${disposable.id}`,{headers:{'X-CNS-Token':config.admin}})).status(),404);
 // Make v1.1 current; v1.0 remains protected because v1.1 is based on it.
 let draft=root.locator('.ct-main-row').filter({hasText:'TEST'}).filter({hasText:'v1.1'});await draft.locator('[data-ct="quick-use"]').click();await root.locator('[data-ct="confirm-use"]').click();await root.locator('.ct-current').filter({hasText:'Cari'}).waitFor();
 const protectedRow=root.locator('.ct-main-row').filter({hasText:'TEST'}).filter({hasText:'v1.0'});await protectedRow.locator('[data-ct="quick-delete"]').click();const protectedModal=root.locator('.cl-native-modal');await protectedModal.locator('[data-ct="confirm-delete"]').click();await protectedModal.waitFor({state:'detached'});
 await page.waitForFunction(()=>document.querySelector('[data-ct-error]')?.textContent.includes('əsaslanan'));assert.doesNotMatch(await root.locator('[data-ct-error]').textContent(),/Unexpected token|DOCTYPE/);
 await page.screenshot({path:'/private/tmp/cns-delete-footer/delete-protected-error.png',fullPage:true});
 const api404=await context.request.delete(base+'/api/stale-admin-delete',{headers:{'X-CNS-Token':config.admin}});assert.equal(api404.status(),404);assert.match(api404.headers()['content-type'],/application\/json/);assert.equal((await api404.json()).error,'API endpoint tapılmadı');
 const other=await browser.newContext();await other.addInitScript(token=>localStorage.setItem('cns_auth_token',token),config.observer);const p=await other.newPage();await p.goto(base);assert.equal(await p.locator('[data-tab="checklist-templates"]').isVisible(),false);
 assert.equal((await other.request.get(base+'/api/checklist-templates',{headers:{'X-CNS-Token':config.observer}})).status(),403);
 const rows=await(await context.request.get(base+'/api/checklist-templates',{headers:{'X-CNS-Token':config.admin}})).json();const prod=rows.find(r=>r.code==='CNS_DAILY_TECHNICAL_CHECK');const versions=await(await context.request.get(base+`/api/checklist-templates/${prod.id}/versions`,{headers:{'X-CNS-Token':config.admin}})).json();assert.equal(versions[0].status,'draft');for(const suffix of ['export','reference'])assert.equal((await other.request.get(base+`/api/checklist-template-versions/${versions[0].id}/${suffix}`,{headers:{'X-CNS-Token':config.observer}})).status(),403);
 // Shift Admin starts empty, creates only an explicit draft and remains responsive. No schedule is published.
 await page.locator('[data-tab="checklist-shifts"]').click();const shifts=page.locator('#tab-checklist-shifts');await page.waitForFunction(()=>document.querySelector('#tab-checklist-shifts')?.textContent.includes('Hələ növbə cədvəli yaradılmayıb'));assert.match(await shifts.textContent(),/Hələ növbə cədvəli yaradılmayıb/);
 await shifts.locator('[data-shift="new"]').click();await shifts.locator('[data-schedule-field="cycle_anchor"]').fill('2099-01-01T20:00');assert.equal(await shifts.locator('[data-rule]').count(),4);assert.deepEqual(await shifts.locator('[data-rule] legend').allTextContents(),['1. Növbə 1 | 20:00 → 08:00','2. Növbə 2 | 08:00 → 20:00','3. Növbə 3 | 20:00 → 08:00','4. Növbə 4 | 08:00 → 20:00']);assert.equal(await shifts.locator('[data-day]').count(),0);
 await shifts.locator('[data-shift="save"]').click();await page.waitForFunction(()=>document.querySelector('[data-shift-status]')?.textContent==='Yadda saxlanıldı');
 assert.match(await shifts.locator('.shift-toolbar').textContent(),/draft/);assert.equal(await shifts.locator('[data-shift="publish"]').count(),1);assert.ok(await shifts.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await shifts.locator('[data-shift="list"]').click();await shifts.locator('.shift-history-row').waitFor();assert.match(await shifts.locator('.shift-history-row').textContent(),/v 1\.0/);await shifts.locator('[data-shift="quick-use"]').click();await shifts.locator('[data-shift="confirm-use"]').click();await page.waitForTimeout(500);if(await shifts.locator('.shift-current').count()===0)throw Error('shift use failed: '+await shifts.locator('[data-shift-error]').textContent());await shifts.locator('.shift-current').waitFor();await page.screenshot({path:'/private/tmp/cns-stage10-admin/shift-flat-actions.png',fullPage:true});
 assert.equal(await shifts.locator('.shift-history-row:has(.shift-current) [data-shift="quick-edit"]').count(),0,'current shift has no Edit');
 // Cloned draft schedules are disposable and must disappear immediately.
 await shifts.locator('.shift-history-row:has(.shift-current) [data-shift="quick-clone"]').click();await shifts.locator('[data-shift="list"]').click();const shiftDraft=shifts.locator('.shift-history-row').filter({hasText:'draft'});await shiftDraft.locator('[data-shift="quick-delete"]').click();const shiftDelete=shifts.locator('.cl-native-modal');await shiftDelete.locator('[data-shift="confirm-delete"]').click();await shiftDelete.waitFor({state:'detached'});assert.equal(await shifts.locator('.shift-history-row').filter({hasText:'draft'}).count(),0);
 assert.equal(await shifts.locator('.shift-history-row:has(.shift-current) [data-shift="quick-delete"]').count(),0,'current schedule stays protected in the UI');
 assert.equal((await other.request.get(base+'/api/checklist-shift-schedules',{headers:{'X-CNS-Token':config.observer}})).status(),403);
 assert.deepEqual(errors,[]);console.log('PASS: template/shift admin draft UI, Excel, responsive layout, immutable controls and permission denial (memory DBs).');
}finally{await browser?.close();child.kill('SIGTERM');}
