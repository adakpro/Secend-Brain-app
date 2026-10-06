import { test, expect, type Page } from '@playwright/test';

// Requires a stack in the test/development profile with MODEL_PROVIDER_MODE=mock (deterministic provider,
// NOT a real model) and an owner created via create-admin. Credentials come from the environment.
const EMAIL = process.env.E2E_EMAIL!; const PASS = process.env.E2E_PASSWORD!;
const stamp = Date.now().toString(36);

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', EMAIL); await page.fill('#password', PASS);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page).toHaveURL(/\/home/);
}

test.describe.serial('core flow: source → proposal → review → apply → cited answer', () => {
  test('rejects a wrong password with a neutral message', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', EMAIL); await page.fill('#password', 'definitely-wrong-pass');
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByRole('alert')).toContainText('نادرست');
  });

  test('ingests a Persian source and applies the reviewed proposal', async ({ page }) => {
    await login(page);
    await page.goto('/inbox');
    await page.getByRole('button', { name: 'افزودن منبع' }).first().click();
    const title = `یادداشت آزمون ${stamp}`;
    await page.fill('#srcText', `# یادگیری فعال ${stamp}\n\nیادگیری فعال یعنی بازیابی دانسته‌ها به‌جای بازخوانی منفعل. مرور با فاصله، به‌خاطرسپاری را تقویت می‌کند.\n`);
    await page.fill('#srcTitle', title);
    await page.getByRole('button', { name: 'ثبت منبع' }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]+$/);
    await expect(page.locator('.section-title .chip')).toContainText('آمادهٔ پردازش', { timeout: 180_000 });
    await page.getByRole('button', { name: /تحلیل و ساخت پیشنهاد/ }).click();
    await expect(page.locator('.section-title .chip')).toContainText('منتظر بررسی', { timeout: 300_000 });
    await page.getByRole('link', { name: /ورود «/ }).first().click();
    await expect(page.locator('.diff-view').first()).toBeVisible();
    await expect(page.getByText('ارائه‌دهندهٔ آزمایشی', { exact: false }).first()).toBeVisible(); // mock is labelled
    await page.getByRole('button', { name: /تأیید و اعمال همه/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'اعمال' }).click();
    await expect(page.locator('.section-title .chip')).toContainText('اعمال‌شده', { timeout: 30_000 });
    await page.goto('/library');
    await expect(page.locator('.note-card h3', { hasText: title }).first()).toBeVisible();
  });

  test('answers from the vault with a validated, clickable citation', async ({ page }) => {
    await login(page);
    await page.goto('/ask');
    await page.getByLabel('پرسش شما').fill(`یادگیری فعال ${stamp} چیست؟`);
    await page.getByRole('button', { name: 'ارسال پرسش' }).click();
    const answer = page.locator('.chat-assistant').last();
    await expect(answer.locator('.cite-item').first()).toBeVisible({ timeout: 300_000 });
    await answer.locator('.cite-item').first().click();
    await expect(page.getByRole('dialog')).toContainText('ساختار ارجاع معتبر');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('projects persist tasks and compute progress from defined tasks', async ({ page }) => {
    await login(page);
    await page.goto('/projects?new=1');
    const dlg = page.getByRole('dialog');
    await dlg.locator('#pj-title').fill(`پروژهٔ آزمون ${stamp}`);
    await dlg.getByRole('button', { name: 'ساخت پروژه' }).click();
    await page.getByText(`پروژهٔ آزمون ${stamp}`).first().click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    for (const t of ['خواندن منبع', 'نوشتن خلاصه']) {
      const inp = page.getByLabel('کار جدید در فرایند');
      await inp.fill(t); await inp.press('Enter');
      await expect(page.locator('.task-row', { hasText: t })).toBeVisible();
    }
    await page.locator('.task-row', { hasText: 'خواندن منبع' }).getByRole('checkbox').check();
    await page.reload();
    await expect(page.getByText('(۱ از ۲)')).toBeVisible();
  });

  test('studio builds a template draft and exports Markdown', async ({ page }) => {
    await login(page);
    await page.goto('/studio?template=report');
    await page.locator('#o-title').fill(`گزارش ${stamp}`);
    await page.locator('.source-checkboxes .check-row').first().locator('input').check();
    await page.getByRole('button', { name: /ساخت قالب مستند/ }).click();
    await expect(page).toHaveURL(/\/studio\/[0-9a-f-]+$/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Markdown' }).click()]);
    const p = await dl.path(); const fs = await import('node:fs');
    expect(fs.readFileSync(p!, 'utf8')).toContain(`# گزارش ${stamp}`);
  });

  test('@mobile layout has no horizontal overflow and a bottom navigation', async ({ page }) => {
    await login(page);
    for (const r of ['/home', '/inbox', '/library', '/ask', '/review', '/graph', '/settings']) {
      await page.goto(r); await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `overflow on ${r}`).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('.mobile-bottom')).toBeVisible();
  });
});
