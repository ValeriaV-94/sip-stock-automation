const { chromium } = require('playwright');

(async () => {
  try {
    console.log("Iniciando navegador...");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto('https://sip.gdu.com.uy/SIP/', {
      waitUntil: 'networkidle'
    });

    await page.waitForTimeout(8000);

    const inputs = await page.$$('input[type="date"]');

    if (inputs.length < 2) {
      throw new Error("No se encontraron inputs de fecha");
    }

    await inputs[0].fill('2026-05-20');
    await inputs[1].fill('2026-05-20');

    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });

    await page.click('text=Descargar');

    const download = await downloadPromise;

    await download.saveAs('stock.csv');

    console.log("DESCARGA OK");

    await browser.close();

  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
})();
