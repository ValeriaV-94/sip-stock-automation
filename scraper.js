const { chromium } = require('playwright');

(async () => {
  try {
    console.log("Iniciando navegador...");

    const browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext({
      acceptDownloads: true
    });

    const page = await context.newPage();

    console.log("Entrando al portal...");
    await page.goto('https://sip.gdu.com.uy/SIP/', {
      waitUntil: 'networkidle'
    });

    // 🔥 CLAVE: esperar que Shiny cargue
    console.log("Esperando render de Shiny...");
    await page.waitForSelector('#DatosSinStock', { timeout: 30000 });

    // Esperar inputs
    await page.waitForTimeout(5000);

    console.log("Buscando inputs...");
    const inputs = await page.$$('input');

    console.log("Cantidad de inputs encontrados:", inputs.length);

    if (inputs.length < 2) {
      throw new Error("No se encontraron suficientes inputs");
    }

    // 🔥 SETEAR FECHAS (IMPORTANTE)
    console.log("Seteando fechas...");
    await inputs[0].fill('2026-05-20');
    await inputs[1].fill('2026-05-20');

    await page.waitForTimeout(2000);

    // 🔥 CLICK DESCARGAR
    console.log("Buscando botón descargar...");
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });

    await page.click('text=Descargar');

    const download = await downloadPromise;

    const path = await download.path();
    console.log("Archivo descargado en:", path);

    await browser.close();

    console.log("Proceso terminado OK");

  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
})();
