import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/private/tmp/cns-browser-test/node_modules/playwright/index.mjs');
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'test/fixtures/roles-browser-server.ts'], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;

try {
  const [out] = await once(child.stdout, 'data');
  const base = `http://127.0.0.1:${JSON.parse(out.toString()).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  await fs.mkdir('/private/tmp/cns-stage10-mobile', { recursive: true });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => localStorage.setItem('cns_auth_token', 'test'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const selectTab = async name => { await page.locator('#mobile-menu-trigger').click(); await page.locator(`.tabs [data-tab="${name}"]`).click(); };

  for (const [width, height] of [[390, 844], [393, 852], [430, 932]]) {
    await page.setViewportSize({ width, height });
    await selectTab('journal');
    const list = page.locator('#journal-mobile-list');
    let card = list.locator('.journal-mobile-card').first();
    assert.equal(await list.isVisible(), true);
    assert.equal(await page.locator('#reports-table').isVisible(), false);
    assert.match(await card.textContent(), /#120.*Aktiv.*CES.*Bakı.*OLDİ, AMHS.*Test nasazlıq 120/s);
    assert.equal(await page.locator('.user-name').isVisible(), true);
    for (const id of ['#btn-password', '#btn-logout']) assert.ok((await page.locator(id).boundingBox()).width > 0);

    await page.locator('#filter-search').fill('nasazlıq 120');
    assert.equal(await list.locator('.journal-mobile-card').count(), 1);
    await page.locator('#filter-search').fill('');
    await page.locator('#filter-xidmet').selectOption('CES');
    await page.locator('#filter-status').selectOption('open');
    assert.ok(await list.locator('.journal-mobile-card').count() > 0);
    card = list.locator('.journal-mobile-card').first();
    const actionRow=card.locator('.jmc-action-row');const summaryBox=await actionRow.locator('summary').boundingBox(),actionBox=await actionRow.locator('.jmc-actions').boundingBox();assert.ok(Math.abs((summaryBox.y+summaryBox.height/2)-(actionBox.y+actionBox.height/2))<3);

    await page.screenshot({ path: `/private/tmp/cns-stage10-mobile/journal-${width}-collapsed.png`, fullPage: true });
    await card.locator('summary').click();
    assert.equal(await card.locator('details').evaluate(element => element.open), true);
    assert.match(await card.textContent(), /Səbəb.*Tədbir.*Müraciət.*Cavabdeh/s);
    await page.screenshot({ path: `/private/tmp/cns-stage10-mobile/journal-${width}-expanded.png`, fullPage: true });

    if (width === 390) {
      await card.locator('[data-del]').click();const deleteModal=page.locator('.cns-delete-modal');await deleteModal.waitFor();assert.equal(await deleteModal.locator('.modal-cancel-button').textContent(),'İmtina');assert.equal(await deleteModal.locator('.modal-delete-button').textContent(),'Sil');assert.ok((await deleteModal.locator('.modal-cancel-button').boundingBox()).height>=44);await page.screenshot({path:'/private/tmp/cns-stage11-admin-final/delete-confirm-phone.png',fullPage:true});await deleteModal.locator('.modal-cancel-button').click();
      const edit = card.locator('[data-edit]');
      assert.ok((await edit.boundingBox()).height >= 44);
      await edit.click();
      assert.equal(await page.locator('#report-modal').isVisible(), true);
      await page.locator('.modal-x[data-close-report-modal]').click();
      await page.screenshot({ path: '/private/tmp/cns-stage10-mobile/navbar-journal-active.png' });
      await selectTab('checklists');
      await page.locator('#tab-checklists').waitFor({ state: 'visible' });
      await page.screenshot({ path: '/private/tmp/cns-stage10-mobile/navbar-checklists-active.png' });
      await selectTab('journal');
      await page.locator('#mobile-menu-trigger').click();assert.equal(await page.locator('.tabs').evaluate(e=>getComputedStyle(e).transform!=='none'),true);assert.equal(await page.locator('.tabs .tab:not(.hidden)').count(),6);await page.screenshot({path:'/private/tmp/cns-stage10-mobile/mobile-drawer-all-sections.png'});await page.keyboard.press('Escape');
      await selectTab('users');await page.locator('.user-mobile-card').first().waitFor();assert.equal(await page.locator('.user-mobile-card').count(),16);assert.equal(await page.locator('.users-desktop-wrap').isVisible(),false);assert.match(await page.locator('.user-mobile-card').first().textContent(),/Admin.*admin.*Sizin hesab/s);assert.ok(await page.locator('.user-mobile-card').nth(1).locator('.row-actions').count());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true);await page.screenshot({path:'/private/tmp/cns-stage10-mobile/users-390.png',fullPage:true});await selectTab('journal');
    }

    const dimensions = await page.evaluate(() => {
      const after = getComputedStyle(document.querySelector('.sidebar'), '::after');
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        list: [document.querySelector('#journal-mobile-list').scrollWidth, document.querySelector('#journal-mobile-list').clientWidth],
        cards: [...document.querySelectorAll('.journal-mobile-card')].every(element => element.scrollWidth <= element.clientWidth + 1),
        navPatch: [after.display, after.backgroundImage, after.content]
      };
    });
    assert.ok(dimensions.page[0] <= dimensions.page[1] + 1, `page overflow ${width}`);
    assert.ok(dimensions.list[0] <= dimensions.list[1] + 1, `list overflow ${width}`);
    assert.equal(dimensions.cards, true);
    assert.equal(dimensions.navPatch[0], 'none');
  }

  for (const [width, height] of [[768, 1024], [1024, 768], [1366, 900]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(()=>document.querySelector('[data-tab="journal"]').click());
    assert.equal(await page.locator('#reports-table').isVisible(), true);
    assert.equal(await page.locator('#journal-mobile-list').isVisible(), false);
    const row=page.locator('#reports-table tbody tr').first(),cells=row.locator('td');assert.match(await cells.nth(3).textContent(),/OLDİ, AMHS/);assert.equal(await cells.nth(10).textContent(),'Süleymanov R.');assert.equal(await cells.nth(11).textContent(),'Asyanov R.');assert.equal(await cells.nth(12).textContent(),'Admin');
    for(const index of [9,10,11,12]){const box=await cells.nth(index).boundingBox(),text=await cells.nth(index).evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));assert.ok(text.scroll<=text.client+1,`cell ${index} overflow at ${width}`);assert.ok(Math.abs((box.y+box.height/2)-((await row.boundingBox()).y+(await row.boundingBox()).height/2))<2);}
    const badge= cells.nth(9).locator('.badge-open'),badgeBox=await badge.boundingBox();assert.ok(badgeBox.height<30,`status wrapped at ${width}`);
    const authorHead=page.locator('#reports-table thead th').nth(12);assert.equal(await authorHead.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,`DAXİL ETDİ clipped at ${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true,`page overflow at ${width}`);
    await page.screenshot({path:`/private/tmp/cns-stage11-admin-final/journal-${width}x${height}.png`,fullPage:true});
    if(width===1366){await row.locator('[data-del]').click();const modal=page.locator('.cns-delete-modal');await modal.waitFor();await page.screenshot({path:'/private/tmp/cns-stage11-admin-final/delete-confirm-desktop.png',fullPage:true});await modal.locator('.modal-cancel-button').click();}
  }
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS: mobile journal at 390/393/430, navbar states, no overflow; tablet and desktop tables preserved.');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
