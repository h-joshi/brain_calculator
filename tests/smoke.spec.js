import { expect, test } from '@playwright/test';

test('launcher links to both games', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Brain Arcade');
  await expect(page.getByRole('link', { name: /Brain Score/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Tilt Rally/i })).toBeVisible();
});

test('Brain Score Calculator loads without page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/Brain%20Score%20Calculator.html');

  await expect(page.locator('body')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Tilt Rally opens its start screen and supports keyboard fallback', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/tilt-rally.html');

  await expect(page.locator('#mode-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: /solo/i })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  expect(errors).toEqual([]);
});
