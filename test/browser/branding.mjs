import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/fixtures/roles-browser-server.ts'],{stdio:['ignore','pipe','inherit']});
let browser;
try{
 const [out]=await once(child.stdout,'data'),base=`http://127.0.0.1:${JSON.parse(out.toString()).port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 await fs.mkdir('/private/tmp/cns-digital-branding',{recursive:true});
 for(const [width,height,label] of [[1366,900,'desktop'],[390,844,'phone']]){
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();
  await page.route('**/api/me',route=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"Giriş tələb olunur"}'}));await page.goto(base);
  assert.equal(await page.title(),'CNS Digital');assert.equal((await page.locator('#login-screen h1').textContent()).trim(),'CNS Digital');assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await page.screenshot({path:`/private/tmp/cns-digital-branding/login-${label}.png`,fullPage:true});await context.close();
 }
 for(const [width,height,label] of [[1366,900,'desktop'],[1024,768,'tablet-landscape'],[768,1024,'tablet-portrait'],[430,932,'phone-430'],[393,852,'phone-393'],[390,844,'phone']]){
  const context=await browser.newContext({viewport:{width,height}});await context.addInitScript(()=>localStorage.setItem('cns_auth_token','test'));const page=await context.newPage();await page.goto(base);
  assert.equal(await page.title(),'CNS Digital');assert.equal((await page.locator('#app-screen .hero-header h1').textContent()).trim(),'CNS Digital');assert.match(await page.locator('#app-screen .app-footer').textContent(),/AZƏRAERONAVİQASİYA.*CNS Digital.*Jahangir Rajabli/s);assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,`overflow ${width}x${height}`);
  if(width<=600){assert.equal((await page.locator('#mobile-nav-title').textContent()).trim(),'CNS Digital');await page.locator('#mobile-menu-trigger').click();assert.equal(await page.locator('#nav-tabs').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await page.locator('#mobile-menu-close').click();await page.locator('#mobile-menu-overlay').waitFor({state:'hidden'});}
  if(label==='desktop'||label==='phone')await page.screenshot({path:`/private/tmp/cns-digital-branding/main-${label}.png`,fullPage:true});await context.close();
 }
 console.log('PASS: CNS Digital login, title, header, footer and responsive branding at 390/393/430/768/1024/1366.');
}finally{await browser?.close();child.kill('SIGTERM');}
