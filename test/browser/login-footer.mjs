import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/fixtures/checklist-template-browser-server.ts'],{stdio:['ignore','pipe','inherit']});let browser;
try{
 const [out]=await once(child.stdout,'data'),base=`http://127.0.0.1:${JSON.parse(out.toString()).port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 await fs.mkdir('/private/tmp/cns-delete-footer',{recursive:true});
 for(const [width,height,name] of [[390,844,'phone'],[768,1024,'tablet-portrait'],[1180,820,'tablet-landscape'],[1366,900,'desktop']]){
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();await page.goto(base);
  const footer=page.locator('#login-screen .login-footer');await footer.waitFor();
  assert.equal((await footer.textContent()).trim(),'© 2026 Jahangir Rajabli. All rights reserved.');
  const metric=await footer.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{left:r.left,right:r.right,bottom:r.bottom,color:s.color,background:s.backgroundColor,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}});
  assert.ok(metric.left>=0&&metric.right<=width&&metric.bottom<=height,`${name}: ${JSON.stringify(metric)}`);assert.equal(metric.color,'rgb(255, 255, 255)');assert.equal(metric.background,'rgba(0, 0, 0, 0)');assert.ok(metric.overflow<=1);
  if(width>600){const panel=await page.locator('.login-panel').boundingBox(),box=await footer.boundingBox();assert.ok(panel&&box);assert.ok(Math.abs((box.x+box.width/2)-(panel.x+panel.width/2))<=1,`${name}: footer is not centered in login panel`);assert.ok(box.x>=panel.x&&box.x+box.width<=panel.x+panel.width+1,`${name}: footer overlaps image`);}
  await page.screenshot({path:`/private/tmp/cns-delete-footer/login-${name}.png`,fullPage:true});await context.close();
 }
 console.log('PASS: minimal login footer; tablet/desktop centered strictly inside the dark login panel.');
}finally{await browser?.close();child.kill('SIGTERM');}
