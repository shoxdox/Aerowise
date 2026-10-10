import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

// A phone screen: two device pixels per CSS pixel.
test.use({ deviceScaleFactor: 2, viewport: { width: 390, height: 844 } });

/**
 * The signature pad draws at the screen's own resolution, so a signature on a phone is not a
 * low-resolution bitmap stretched to fit; the PNG that goes on the agreement keeps that detail.
 */
test("the signature pad's bitmap matches the screen's pixel density", async ({ page, browser }) => {
  // A renewal link for a seeded contract, made by the office.
  const office = (await browser.newContext()).request;
  expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  let link: string | null = null;
  try {
    const contracts = await db.query(
      `select c.id from contracts c join organizations o on o.id = c.organization_id
       where o.name like 'Hill Country Aerobic Services%' and c.status = 'active'
         and not exists (select 1 from renewals r where r.contract_id = c.id and r.status in ('upcoming', 'sent', 'viewed', 'signed', 'payment_pending', 'paid', 'needs_review'))
       order by c.end_on limit 5`,
    );
    for (const row of contracts.rows as { id: string }[]) {
      const res = await office.post(`/api/contracts/${row.id}/renewal`, { data: { send: false } });
      if (res.status() === 201) {
        link = ((await res.json()) as { link: string }).link;
        break;
      }
    }
  } finally {
    await db.end();
  }
  expect(link, "a renewal could be started for a seeded contract").not.toBeNull();

  await page.goto(new URL(link!).pathname);
  await page.getByRole("button", { name: "Draw my signature" }).click();
  const pad = page.locator("canvas.signature-pad");
  await expect(pad).toBeVisible();
  const sizes = await pad.evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight, dpr: window.devicePixelRatio }));
  expect(sizes.dpr).toBe(2);
  expect(sizes.width).toBe(Math.round(sizes.cssWidth * 2));
  expect(sizes.height).toBe(Math.round(sizes.cssHeight * 2));

  // A stroke lands where the finger went, in CSS pixels, and the PNG is at full resolution.
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("Signed.")).toBeVisible();
  const png = await pad.evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));
  const header = Buffer.from(png.split(",")[1]!, "base64");
  // PNG width and height are big-endian at bytes 16 and 20 of the IHDR chunk.
  expect(header.readUInt32BE(16)).toBe(sizes.width);
  expect(header.readUInt32BE(20)).toBe(sizes.height);
});
