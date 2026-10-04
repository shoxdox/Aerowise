import { expect, test } from "@playwright/test";

test("the office sees tomorrow's route on the map with its driving, and puts a shorter order in place", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // The seed puts four stops on the technician's route tomorrow, leaving from the office.
  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);

  await page.goto("/schedule");
  await page.locator('input[type="date"]').fill(date);
  await expect(page.getByRole("img", { name: /Map of 1 route/ })).toBeVisible();
  const column = page.locator(".column", { hasText: "4 stops" });
  await expect(column.getByText(/\d+(\.\d)? mi · .* driving/)).toBeVisible();
  await expect(column.getByText(/from the start/)).toBeVisible();
  await expect(column.getByText(/back to the start/)).toBeVisible();

  const before = await column.locator(".card.tight strong").allTextContents();
  await column.getByRole("button", { name: "Optimize route" }).click();
  await expect(column.getByText(/A shorter order saves/)).toBeVisible();
  await column.getByRole("button", { name: "Use this order" }).click();
  await expect(column.getByText(/A shorter order saves/)).toHaveCount(0);
  await expect(column.locator(".card.tight strong")).not.toHaveText(before);

  // Asking again finds nothing better.
  await column.getByRole("button", { name: "Optimize route" }).click();
  await expect(column.getByText("This is already the shortest order found.")).toBeVisible();

  // The settings page shows where the day starts.
  await page.getByRole("link", { name: "Route settings" }).click();
  await expect(page.getByText("100 Example Pkwy, Dripping Springs, TX 78620")).toBeVisible();
});
