/** /support の表示・導線をローカルの Supabase モックと Chromium で確認する。 */
import { chromium } from "playwright";
import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { startApp } from "./server.mjs";

installLocalOnlyGuard("支援画面のブラウザ試験");

let app;
let browser;
try {
  app = await startApp({ port: 3222 });
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${app.base}/support`, { waitUntil: "networkidle" });
    if (!(await page.getByRole("heading", { name: "つたわるかなを支援する" }).isVisible())) {
      throw new Error(`${width}px: 支援ページの見出しがない`);
    }
    if (!(await page.getByRole("heading", { name: "Founding Creator" }).isVisible())) {
      throw new Error(`${width}px: Founder の案内がない`);
    }
    if ((await page.locator("#support-amount").inputValue()) !== "1000") {
      throw new Error(`${width}px: 初期金額が違う`);
    }
    if (!(await page.getByText("支援による機能上の優遇や特典はありません。", { exact: true }).isVisible())) {
      throw new Error(`${width}px: 特典がない旨がない`);
    }
    if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth + 1)) {
      throw new Error(`${width}px: 横方向にはみ出している`);
    }
    if (errors.length) throw new Error(`${width}px: ${errors.join("; ")}`);
    if (process.env.SUPPORT_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SUPPORT_SCREENSHOT_DIR}/support-${width}.png`, fullPage: true });
    }
    await page.close();
  }

  const page = await browser.newPage();
  await page.goto(`${app.base}/support/thanks`, { waitUntil: "networkidle" });
  if (await page.getByText("応援ありがとうございます。", { exact: true }).count()) {
    throw new Error("Checkout なしで成功表示が出た");
  }
  await page.goto(`${app.base}/founder`, { waitUntil: "networkidle" });
  if (!(await page.getByRole("link", { name: "Founder にならずに自由な金額で応援する" }).isVisible())) {
    throw new Error("Founder からの支援導線がない");
  }
  await Promise.all([
    page.waitForURL(/\/support\?source=founder$/),
    page.getByRole("link", { name: "Founder にならずに自由な金額で応援する" }).click(),
  ]);
  await page.close();
  console.log("支援画面: desktop/mobile、金額、法務表示、成功画面、Founder 導線を確認しました。");
} finally {
  await browser?.close();
  await app?.close();
}
