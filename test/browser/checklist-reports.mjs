import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/fixtures/checklist-browser-server.ts'],{env:{...process.env,REPORT_MISSING:'1'},stdio:['ignore','pipe','inherit']});let browser;
try{
 const [out]=await once(child.stdout,'data'),config=JSON.parse(out.toString()),base=`http://127.0.0.1:${config.port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const c=await browser.newContext({viewport:{width:768,height:1024}});await c.addInitScript(token=>localStorage.setItem('cns_auth_token',token),config.tech);
 const page=await c.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(base);await page.locator('[data-tab="checklists"]').click();await page.locator('[data-cl="create"]').click();
 const root=page.locator('#tab-checklists');await root.locator('[data-result="problem"]').click();await root.locator('[data-comment]').fill('Monitor issue');await root.locator('[data-comment]').blur();
 await root.locator('[data-cl="report-create"]').click();await page.waitForSelector('[data-report-field]');assert.equal(await root.locator('[data-report-field]').count(),1);assert.equal(await root.locator('[data-report-field]').getAttribute('data-report-field'),'xidmet');
 await root.locator('[data-report-field]').fill('CES');await root.locator('[data-cl="report-create"]').click();await page.waitForFunction(()=>document.querySelector('[data-relation]')?.textContent.includes('yaradılıb'));
 const headers={'X-CNS-Token':config.tech},rows=async()=>await(await c.request.get(base+'/api/reports',{headers})).json();assert.equal((await rows()).length,1);
 const runs=await(await c.request.get(base+'/api/checklists',{headers})).json(),runId=runs.rows[0].id,run=await(await c.request.get(base+'/api/checklists/'+runId,{headers})).json();
 const section=await(await c.request.get(`${base}/api/checklists/${runId}/sections/${run.sections[0].id}`,{headers})).json(),itemId=section.items[0].id;
 assert.equal((await c.request.post(`${base}/api/checklists/${runId}/items/${itemId}/report`,{headers,data:{}})).status(),200);assert.equal((await rows()).length,1);
 await root.locator('[data-cl="report-open"]').click();await page.waitForFunction(()=>document.querySelector('#app-screen')?.dataset.view==='journal');assert.match(await page.locator('#reports-table').textContent(),/Monitor issue/);
 await page.locator('[data-tab="checklists"]').click();await root.locator('[data-cl="open"]').first().click();await root.locator('[data-result="ok"]').click();await page.waitForFunction(()=>document.querySelector('[data-save]')?.textContent==='Yadda saxlanıldı');await page.waitForFunction(()=>document.querySelector('[data-relation]')?.textContent.includes('yaradılıb'));assert.equal((await rows()).length,1);
 await root.locator('[data-cl="next"]').click();await root.locator('[data-result="problem"]').click();await root.locator('[data-comment]').fill('VCS issue');await root.locator('[data-comment]').blur();
 await c.request.post(base+'/test-fail-link',{data:{enabled:true}});await root.locator('[data-cl="report-create"]').click();await page.waitForFunction(()=>document.querySelector('[data-relation]')?.textContent.includes('Yaratmaq mümkün olmadı'));assert.equal((await rows()).length,2);
 await c.request.post(base+'/test-fail-link',{data:{enabled:false}});await root.locator('[data-cl="report-create"]').click();await page.waitForFunction(()=>document.querySelector('[data-relation]')?.textContent.includes('yaradılıb'));assert.equal((await rows()).length,2);
 await c.request.post(base+'/test-delete-report',{data:{id:(await rows())[1].id}});await root.locator('[data-cl="previous"]').click();await root.locator('[data-cl="next"]').click();await page.waitForFunction(()=>document.querySelector('[data-relation]')?.textContent.includes('silinib'));assert.equal(await root.locator('[data-cl="report-create"]').count(),0);
 await page.screenshot({path:'/private/tmp/CNS-stage6-report-link.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS: missing-field form, report creation, retry, journal open, Problem→OK retention, cross-DB failure recovery and deleted state.');
}finally{await browser?.close();child.kill('SIGTERM');}
