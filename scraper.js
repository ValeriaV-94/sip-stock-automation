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

    console.log("Esperando que cargue Shiny...");
    await page.waitForTimeout(10000);

    // 🔥 DEBUG: listar todos los inputs
    const allInputs = await page.$$eval('input', els =>
      els.map(e => ({
        type: e.type,
        name: e.name,
        id: e.id,
        value: e.value
      }))
    );

    console.log("INPUTS DETECTADOS:");
    console.log(JSON.stringify(allInputs, null, 2));

    // 🔥 Intentar ubicar inputs por posición (más robusto)
    const inputs = await page.$$('input');

    if (inputs.length < 2) {
      throw new Error("No hay suficientes inputs en la página");
    }

    console.log("Cargando fechas...");

    await inputs[0].fill('2026-05-20');
    await inputs[1].fill('2026-05-20');

    await page.waitForTimeout(2000);

    console.log("Buscando botón descargar...");

    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });

    // 🔥 selector más flexible
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
