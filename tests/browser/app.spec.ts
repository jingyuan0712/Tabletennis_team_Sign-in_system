import { test, expect, type Page, type Route } from '@playwright/test';

async function register(page: Page, name: string, status: '請假' | '遲到', reason: string) {
  await page.getByLabel('姓名', { exact: false }).fill(name);
  await page.getByRole('button', { name: status + (status === '請假' ? ' 今天無法出席' : ' 會晚一點抵達') }).click();
  await page.getByLabel('原因', { exact: false }).fill(reason);
}

test('lost successful POST response followed by edited retry preserves edits and updates only one registration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '送出今日登記' })).toBeEnabled();
  await register(page, '回覆中斷測試', '請假', '第一次填寫的原因');
  await page.route('**/api/entries', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort(); // The database committed; the browser never received success.
  });
  await page.getByRole('button', { name: '送出今日登記' }).click();
  await expect(page.getByRole('alert')).toContainText('連線失敗');
  await page.unroute('**/api/entries');
  await page.getByLabel('原因', { exact: false }).fill('回覆中斷後改過的原因');
  await page.getByRole('button', { name: '送出今日登記' }).click();
  await expect(page.getByRole('alert')).toContainText('先前的登記已送達');
  await expect(page.getByLabel('原因', { exact: false })).toHaveValue('回覆中斷後改過的原因');
  await page.getByRole('button', { name: '儲存修改' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText('回覆中斷後改過的原因');
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await page.getByRole('button', { name: '確認撤回' }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
});

test('a slow roster read is not replaced by overlapping polls and still renders its result', async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date('2026-10-18T10:00:00Z'));
  let reads = 0;
  let first: Route | undefined;
  const today = { day: '2026-10-18', serverNow: '2026-10-18T10:00:00.000Z', nextResetAt: '2026-10-18T16:00:00.000Z', entries: [{ id: 'slow', day: '2026-10-18', name: '慢速連線測試', status: 'leave', reason: '仍須正常讀取', eta: null, createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z' }] };
  await page.route('**/api/today', async route => {
    if (++reads === 1) first = route;
    else await route.fulfill({ json: today });
  });
  await page.goto('/');
  await expect.poll(() => reads).toBe(1);
  await page.clock.runFor(10_100);
  expect(reads).toBe(1);
  await first!.fulfill({ json: today });
  await expect(page.getByRole('article')).toContainText('慢速連線測試');
  await expect.poll(() => reads).toBe(2);
});

test('two independent browsers share data, ownership, edit and withdraw auto-sync; duplicate and error recovery', async ({ browser }) => {
  const first = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const second = await browser.newContext({ timezoneId: 'Pacific/Auckland' });
  const a = await first.newPage(); const b = await second.newPage();
  try {
    await Promise.all([a.goto('/'), b.goto('/')]);
    await expect(a.getByText('今天還沒有人登記請假或遲到。')).toBeVisible();
    await a.screenshot({ path: '.test-data/preview-desktop.png', fullPage: true });
    await register(a, '測試隊員甲', '請假', '');
    await a.getByRole('button', { name: '送出今日登記' }).click();
    await expect(a.getByRole('alert')).toContainText('原因必填');
    await a.getByLabel('原因', { exact: false }).fill('今天臨時有事');
    // A simulated network error preserves fields and a retry uses the same identity.
    await a.route('**/api/entries', route => route.abort());
    await a.getByRole('button', { name: '送出今日登記' }).click();
    await expect(a.getByRole('alert')).toContainText('連線失敗');
    await expect(a.getByLabel('姓名', { exact: false })).toHaveValue('測試隊員甲');
    await a.unroute('**/api/entries');
    await a.getByRole('button', { name: '重試送出' }).click();
    await expect(a.getByRole('article')).toHaveCount(1);
    await expect(b.getByRole('article')).toHaveCount(1, { timeout: 15_000 });
    await expect(b.getByRole('button', { name: '修改', exact: true })).toHaveCount(0);
    const mine = await a.evaluate(() => JSON.parse(localStorage.getItem('table-tennis:management:v1')!)[0]);
    const publicResponse = await b.request.get('/api/today');
    expect(await publicResponse.text()).not.toContain(mine.token);
    expect((await b.request.put(`/api/entries/${mine.id}`, { headers: { Origin: 'http://127.0.0.1:3187' }, data: { name: '偷改', status: 'leave', reason: '失敗' } })).status()).toBe(403);
    await a.getByRole('button', { name: '修改', exact: true }).click();
    await a.getByRole('button', { name: '遲到 會晚一點抵達' }).click();
    await a.getByLabel('預計抵達時間', { exact: false }).fill('20:30');
    await a.getByLabel('原因', { exact: false }).fill('改為晚點抵達');
    await a.getByRole('button', { name: '儲存修改' }).click();
    await expect(b.getByRole('article')).toContainText('改為晚點抵達', { timeout: 15_000 });
    await expect(b.getByRole('article')).toContainText('20:30');
    await register(b, '測試隊員甲', '請假', '我是同名隊員');
    await b.getByRole('button', { name: '送出今日登記' }).click();
    await expect(b.getByRole('alert')).toContainText('完全相同姓名');
    await b.getByRole('checkbox').check();
    await b.getByRole('button', { name: '送出今日登記' }).click();
    await expect(b.getByRole('article')).toHaveCount(2);
    await expect(a.getByRole('article')).toHaveCount(2, { timeout: 15_000 });
    await a.getByRole('button', { name: '撤回', exact: true }).click();
    await a.getByRole('button', { name: '確認撤回' }).click();
    await expect(b.getByRole('article')).toHaveCount(1, { timeout: 15_000 });
    await b.getByRole('button', { name: '撤回', exact: true }).click();
    await b.getByRole('button', { name: '確認撤回' }).click();
  } finally { await first.close(); await second.close(); }
});

test('mobile 320/375/390px: long names/reasons wrap, no overflow, filter and touch target sizes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '送出今日登記' })).toBeEnabled();
    await page.screenshot({ path: '.test-data/preview-mobile.png', fullPage: true });
    await register(page, '長'.repeat(20), '遲到', 'LongUnbrokenReason'.repeat(11));
    await page.getByRole('button', { name: '送出今日登記' }).click();
    await expect(page.getByRole('article')).toHaveCount(1);
    for (const width of [320, 375, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const bounds = await page.getByRole('button', { name: '送出今日登記' }).boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: '請假', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByRole('button', { name: '撤回', exact: true }).click();
    await page.getByRole('button', { name: '確認撤回' }).click();
  } finally { await context.close(); }
});

test('open page crosses Taipei midnight using server clock, clears expired list even offline', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/today', route => route.fulfill({ json: { day: '2026-10-15', serverNow: '2026-10-15T15:59:59.000Z', nextResetAt: '2026-10-15T16:00:00.000Z', entries: [{ id: 'old', name: '昨日隊員', status: 'leave', reason: '舊原因', eta: null, day: '2026-10-15', createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z' }] } }));
  await page.goto('/');
  await expect(page.getByRole('article')).toContainText('昨日隊員');
  await page.unroute('**/api/today');
  await page.route('**/api/today', route => route.abort());
  await page.clock.runFor(1500);
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByText('今天還沒有人登記請假或遲到。')).toBeVisible();
  await expect(page.locator('.today-date')).toContainText('10月16日');
});

test('footer admin login moderates another browser registration, reload restores session, logout revokes', async ({ browser }) => {
  const member = await browser.newContext();
  const manager = await browser.newContext({ viewport: { width: 375, height: 812 } });
  try {
    const a = await member.newPage(); const b = await manager.newPage();
    await Promise.all([a.goto('/'), b.goto('/')]);
    await register(a, '待管理登記', '請假', '隊員填寫的原因');
    await a.getByRole('button', { name: '送出今日登記' }).click();
    await expect(b.getByRole('article')).toHaveCount(1, { timeout: 15_000 });
    await expect(b.getByRole('button', { name: '修改', exact: true })).toHaveCount(0);
    await b.getByRole('button', { name: '管理員登入', exact: true }).click();
    await b.getByLabel('管理員帳號', { exact: true }).fill('test-coach');
    await b.getByLabel('管理員密碼', { exact: true }).fill('wrong-password');
    await b.getByRole('button', { name: '登入管理員', exact: true }).click();
    await expect(b.getByRole('alert')).toContainText('帳號或密碼不正確');
    await b.getByLabel('管理員密碼', { exact: true }).fill('browser-admin-test-only');
    await b.getByRole('button', { name: '登入管理員', exact: true }).click();
    await expect(b.getByRole('button', { name: '登出管理員' })).toBeVisible();
    await b.reload();
    await expect(b.getByRole('button', { name: '登出管理員' })).toBeVisible();
    const session = await b.evaluate(() => sessionStorage.getItem('table-tennis:admin-session:v1'));
    expect(await b.evaluate(() => localStorage.getItem('table-tennis:admin-session:v1'))).toBeNull();
    await b.getByRole('button', { name: '修改', exact: true }).click();
    await expect(b.getByRole('heading', { name: '管理員修改登記' })).toBeVisible();
    await b.getByLabel('原因', { exact: false }).fill('管理員已修正內容');
    await b.getByRole('button', { name: '儲存修改' }).click();
    await expect(a.getByRole('article')).toContainText('管理員已修正內容', { timeout: 15_000 });
    expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Administrator edits do not add the other person's credential to local ownership.
    expect(await b.evaluate(() => JSON.parse(localStorage.getItem('table-tennis:management:v1') || '[]').length)).toBe(0);
    await b.getByRole('button', { name: '刪除', exact: true }).click();
    await b.getByRole('button', { name: '確認刪除', exact: true }).click();
    await expect(a.getByRole('article')).toHaveCount(0, { timeout: 15_000 });
    await b.getByRole('button', { name: '登出管理員' }).click();
    await expect(b.getByRole('button', { name: '管理員登入', exact: true })).toBeVisible();
    expect((await b.request.get('/api/admin/session', { headers: { Authorization: `Bearer ${session}` } })).status()).toBe(401);
    await expect(a.getByRole('button', { name: '送出今日登記' })).toBeEnabled();
  } finally { await member.close(); await manager.close(); }
});
