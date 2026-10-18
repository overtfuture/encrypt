import type { Page } from '@playwright/test';
import beacons from './fixtures/quicknet.json' with { type: 'json' };

export async function fixtureDrand(page: Page, available = true) {
  const state = { available, requests: [] as string[] };
  const handle = async (route: import('@playwright/test').Route) => {
    const url = route.request().url();
    state.requests.push(url);
    const round = new URL(url).pathname
      .split('/')
      .at(-1) as keyof typeof beacons;
    const beacon = state.available && beacons[round];
    await route.fulfill({
      status: beacon ? 200 : 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(beacon || { error: 'Round not found' }),
    });
  };
  await page.route('https://*.drand.sh/**', handle);
  await page.route('https://drand.cloudflare.com/**', handle);
  return state;
}
