import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/fixtures/roles-browser-server.ts'],{stdio:['ignore','pipe','inherit']});let browser;
const metrics=footer=>footer.evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),children=[...e.children].map(n=>{const b=n.getBoundingClientRect(),cs=getComputedStyle(n);return{top:+(b.top-r.top).toFixed(2),height:+b.height.toFixed(2),lineHeight:cs.lineHeight,whiteSpace:cs.whiteSpace,position:cs.position,display:cs.display,flex:cs.flex}});return{width:+r.width.toFixed(2),height:+r.height.toFixed(2),flexDirection:s.flexDirection,textAlign:s.textAlign,whiteSpace:s.whiteSpace,lineHeight:s.lineHeight,gap:s.gap,padding:s.padding,children,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
try{
 const [out]=await once(child.stdout,'data'),base=`http://127.0.0.1:${JSON.parse(out.toString()).port}`;browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});await fs.mkdir('/private/tmp/cns-footer-consistency',{recursive:true});
 for(const [width,height] of [[390,844],[393,852],[430,932]]){
  const context=await browser.newContext({viewport:{width,height}});await context.addInitScript(()=>localStorage.setItem('cns_auth_token','test'));const page=await context.newPage();await page.goto(base);const footer=page.locator('#app-screen .app-footer');const values={};
  for(const view of ['users','checklists','roles']){await page.locator('#mobile-menu-trigger').click();await page.locator(`[data-tab="${view}"]`).click();await page.locator(`#tab-${view}:not(.hidden)`).waitFor();values[view]=await metrics(footer);assert.equal(values[view].overflow,0,`${view} overflow at ${width}`);}
  for(const key of ['width','height','flexDirection','textAlign','whiteSpace','lineHeight','gap','padding','children']){assert.deepEqual(values.checklists[key],values.users[key],`${key}: checklist/users mismatch at ${width}`);assert.deepEqual(values.checklists[key],values.roles[key],`${key}: checklist/roles mismatch at ${width}`);}
  assert.equal(values.checklists.flexDirection,'column');assert.equal(values.checklists.textAlign,'center');assert.equal(values.checklists.children.length,3);
  if(width===390){await page.locator('#mobile-menu-trigger').click();await page.locator('[data-tab="users"]').click();await footer.scrollIntoViewIfNeeded();await page.screenshot({path:'/private/tmp/cns-footer-consistency/users-390.png'});await page.locator('#mobile-menu-trigger').click();await page.locator('[data-tab="checklists"]').click();await footer.scrollIntoViewIfNeeded();await page.screenshot({path:'/private/tmp/cns-footer-consistency/checklists-390.png'});await fs.writeFile('/private/tmp/cns-footer-consistency/computed-390.json',JSON.stringify(values,null,2));}
  await context.close();
 }
 console.log('PASS: Users, Checklists and Roles share identical mobile footer geometry and computed styles at 390/393/430.');
}finally{await browser?.close();child.kill('SIGTERM');}
