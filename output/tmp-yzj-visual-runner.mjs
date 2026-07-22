import { chromium } from "playwright";
import { resolve } from "node:path";
const url = process.argv[2];
const output = resolve(process.argv[3] ?? "output/tmp-yzj-visual.png");
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  let waitError = null;
  try {
    await page.waitForFunction(() => document.body.dataset.ready === "true" || ["pass", "passed", "failed"].includes(document.body.dataset.validationStatus), null, { timeout: 30000 });
  } catch (error) {
    waitError = error instanceof Error ? error.message : String(error);
  }
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => ({
    ready: document.body.dataset.ready,
    validationStatus: document.body.dataset.validationStatus,
    statusText: document.querySelector("#info, #status")?.textContent ?? "",
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    yzjReferenceParameterReport: window.__yzjReferenceParameterReport ?? null,
    yzjValidationReport: window.__yzjValidationReport ?? null,
  }));
  await page.screenshot({ path: output, fullPage: false });
  console.log(JSON.stringify({ output, state, errors, waitError }, null, 2));
  if (errors.length > 0 || waitError || state.validationStatus === "failed") process.exitCode = 2;
} finally {
  await browser.close();
}
