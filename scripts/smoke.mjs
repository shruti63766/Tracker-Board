import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const appUrl = process.env.APP_URL || "http://127.0.0.1:5173/?data=local";

await mkdir("test-results", { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});

const checks = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
];

const failures = [];

for (const check of checks) {
  const page = await browser.newPage({ viewport: check.viewport });
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("trackboard:v1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.screenshot({
    path: `test-results/${check.name}.png`,
    fullPage: true,
  });

  const title = await page.locator("h1").first().textContent().catch(() => "");
  const setupVisible = await page.getByRole("button", { name: "Create admin" }).isVisible().catch(() => false);
  const leakedCreds = await page.getByText("ADM001").isVisible().catch(() => false);

  if (title !== "Tracker-Board") {
    failures.push(`${check.name}: expected Tracker-Board heading, received "${title || "none"}"`);
  }
  if (!setupVisible) {
    failures.push(`${check.name}: Create admin button is not visible`);
  }
  if (leakedCreds) {
    failures.push(`${check.name}: demo credentials are visible`);
  }
  if (consoleErrors.length > 0) {
    failures.push(`${check.name}: console errors: ${consoleErrors.join(" | ")}`);
  }
  if (pageErrors.length > 0) {
    failures.push(`${check.name}: page errors: ${pageErrors.join(" | ")}`);
  }

  await page.close();
}

await browser.close();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Smoke checks passed. Screenshots: test-results/desktop.png, test-results/mobile.png");
