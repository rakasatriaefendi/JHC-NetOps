import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const TEST_EMAIL = process.env.P18_BROWSER_TEST_EMAIL;
const TEST_PASSWORD = process.env.P18_BROWSER_TEST_PASSWORD;
const isolatedBackend = process.env.P18_BROWSER_TEST_ISOLATED === '1' &&
  process.env.LOCAL_BACKEND_URL === 'http://127.0.0.1:3402' &&
  !!process.env.LOCAL_BACKEND_FRONTEND_TOKEN && !!TEST_EMAIL && !!TEST_PASSWORD;

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL!);
  await page.fill('input[type="password"]', TEST_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/dashboard/);
}

async function waitForMonitoringState(page: Page, expectedState: 'ACTIVE' | 'STANDBY' | 'ACTIVATING' | 'DRAINING' | 'DEGRADED', timeout = 10000) {
  const labels = {
    ACTIVE: /Monitoring active|Monitoring aktif/,
    STANDBY: /Monitoring standby|Monitoring siaga/,
    ACTIVATING: /Resuming monitoring|Melanjutkan monitoring/,
    DRAINING: /Finishing accepted work|Menyelesaikan pekerjaan diterima/,
    DEGRADED: /Monitoring degraded|Monitoring terdegradasi/,
  };
  await expect(page.locator('aside[role="status"]')).toContainText(labels[expectedState], { timeout });
}

test.describe('P18 Monitoring Presence and Standby', () => {
  test.skip(!isolatedBackend, 'Requires an operator-verified disposable local backend and approved test account; no API mocks.');
  test.beforeEach(async ({ page }: { page: Page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
  });

  test('authenticated visible dashboard shows ACTIVE monitoring', async ({ page }: { page: Page }) => {
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');
    await expect(page.locator('aside[role="status"]')).toContainText(/Scheduled monitoring enabled|Monitoring terjadwal diaktifkan/);
    await expect(page.locator('aside[role="status"]')).toContainText(/Runner control connected|Kontrol runner terhubung/);
  });

  test('last visible tab hidden transitions to STANDBY after grace period', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    test.skip(true, 'Opening an authenticated page creates new visible presence; this flow cannot observe final-tab standby without a separate isolated backend observer.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    const page2 = await context.newPage();
    await login(page2);
    await waitForMonitoringState(page2, 'ACTIVE');

    await page.close();
    await page2.close();

    const page3 = await context.newPage();
    await page3.goto('/dashboard');
    await page3.waitForLoadState('networkidle');
    await waitForMonitoringState(page3, 'STANDBY', 40000);
    await expect(page3.locator('[role="status"]')).toContainText('notLive');
    await expect(page3.locator('[role="status"]')).toContainText('lastObservation');
  });

  test('visible tab returns resumes ACTIVE monitoring', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    test.skip(true, 'Requires a real browser visibility transition and a separate isolated backend observer; a reload itself resumes presence.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    await page.close();

    const page2 = await context.newPage();
    await page2.goto('/dashboard');
    await page2.waitForLoadState('networkidle');
    await waitForMonitoringState(page2, 'STANDBY', 40000);

    await page2.reload();
    await waitForMonitoringState(page2, 'ACTIVE', 15000);
    await expect(page2.locator('[role="status"]')).toContainText('live');
    await expect(page2.locator('[role="status"]')).toContainText('connected');
  });

  test('multiple tabs/users retain presence correctly', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    const page2 = await context.newPage();
    await page2.goto('/dashboard');
    await waitForMonitoringState(page2, 'ACTIVE');

    const page3 = await context.newPage();
    await page3.goto('/dashboard');
    await waitForMonitoringState(page3, 'ACTIVE');

    await page.close();
    await waitForMonitoringState(page2, 'ACTIVE');
    await waitForMonitoringState(page3, 'ACTIVE');

    await page2.close();
    await waitForMonitoringState(page3, 'ACTIVE');

    await page3.close();
  });

  test('logout removes presence', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    const page2 = await context.newPage();
    await page2.goto('/dashboard');
    await waitForMonitoringState(page2, 'ACTIVE');

    await page.getByRole('button', { name: /Sign out|Keluar/i }).click();
    await expect(page).toHaveURL(/\/login/);

    // Tabs in one context share the same session cookie; logout must revoke it.
    await page2.reload();
    await expect(page2).toHaveURL(/\/login/);
  });

  test('expired session removes presence', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    await context.clearCookies();

    const page2 = await context.newPage();
    await page2.goto('/dashboard');
    await page2.waitForLoadState('networkidle');
    await expect(page2).toHaveURL(/\/login/);
  });

  test('hidden tabs suspend periodic application HTTP requests', async ({ page }: { page: Page }) => {
    test.skip(true, 'Dispatching visibilitychange alone does not make document.visibilityState hidden; needs real background-tab automation.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/') && !request.url().includes('/api/realtime/presence')) {
        requests.push(request.url());
      }
    });

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(5000);

    const apiRequestsWhileHidden = requests.filter((url) => !url.includes('/api/realtime/presence'));
    expect(apiRequestsWhileHidden.length).toBeLessThan(5);

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(2000);
  });

  test('Health Watch drawer displays PAUSED when suspended', async ({ page }: { page: Page }) => {
    test.skip(true, 'Requires a seeded Health target and real standby transition; synthetic visibilitychange is insufficient.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    await page.click('button:has-text("Health")');
    await expect(page.locator('[role="dialog"], [role="drawer"]')).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(5000);

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('text=/paused|PAUSED/i')).toBeVisible({ timeout: 10000 });
  });

  test('SNMP device profile distinguishes stale observations from live monitoring', async ({ page }: { page: Page }) => {
    test.skip(true, 'Requires a seeded managed target and direct Device Profile navigation, plus a real standby transition.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    await page.click('button:has-text("Devices")');
    await expect(page.locator('[role="dialog"], [role="drawer"]')).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(5000);

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect(page.locator('text=/stale|STALE|last observed/i')).toBeVisible({ timeout: 10000 });
  });

  test('mobile and desktop paused-state indicators remain visible', async ({ page }: { page: Page }) => {
    test.skip(true, 'A dispatched visibilitychange does not hide a tab or enter STANDBY.');
    await login(page);
    await waitForMonitoringState(page, 'ACTIVE');

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(40000);
    await waitForMonitoringState(page, 'STANDBY', 45000);

    const statusBar = page.locator('aside[role="status"]');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toContainText('STANDBY');
    await expect(statusBar).toContainText('notLive');
    await expect(statusBar).toContainText('lastObservation');
  });

  test('anonymous/login pages never activate monitoring', async ({ page }: { page: Page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const statusBar = page.locator('aside[role="status"]');
    await expect(statusBar).not.toBeVisible();

    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(statusBar).not.toBeVisible();
  });
});
