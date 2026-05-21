const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://sip.gdu.com.uy/SIP/', {
    waitUntil: 'networkidle'
  });

  // Esperar que cargue el selector de fechas
  await page.waitForSelector('input[type="date"]');

  // Setear fechas (puedes parametrizar luego)
  await page.fill('input[name="daterange1"]', '2026-05-20');
  await page.fill('input[name="daterange2"]', '2026-05-20');

  // Click en descargar
  await page.click('a#Descargasinstock');

  // Esperar descarga
  const download = await page.waitForEvent('download');

  await download.saveAs('stock.csv');

  await browser.close();
})();
