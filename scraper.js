const { chromium } = require('playwright');

(async () => {
  try {
    console.log('Iniciando navegador...');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://sip.gdu.com.uy/SIP/', {
      waitUntil: 'networkidle'
    });

    console.log('Esperando que cargue la app...');

    // 🔥 CLAVE: esperar a que la app cargue dinámicamente
    await page.waitForTimeout(10000);

    // 🔍 DEBUG: ver todo lo que hay
    const content = await page.content();
    console.log('HTML cargado');

    // 🔎 Buscar inputs visibles realmente
    const inputs = await page.locator('input').all();

    console.log('Cantidad de inputs:', inputs.length);

    for (let i = 0; i < inputs.length; i++) {
      const type = await inputs[i].getAttribute('type');
      console.log(`Input ${i}: type=${type}`);
    }

    // 🔥 INTENTO MÁS ROBUSTO: buscar por placeholder o posición
    const dateInputs = await page.locator('input').filter({
      has: page.locator('')
    });

    if (inputs.length < 2) {
      throw new Error('No se detectaron suficientes inputs dinámicos');
    }

    // 👉 Ajustar manualmente índices según debug
    await inputs[0].fill('2026-05-20');
    await inputs[1].fill('2026-05-20');

    console.log('Fechas cargadas');

    // 🔥 Buscar botón por TEXTO (esto es clave)
    const downloadBtn = page.locator('text=Descargar');

    await downloadBtn.waitFor({ timeout: 15000 });

    const downloadPromise = page.waitForEvent('download');

    await downloadBtn.click();

    const download = await downloadPromise;

    const path = await download.path();

    console.log('Archivo descargado en:', path);

    // 👉 enviar resultado a n8n
    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok' })
    });

    await browser.close();

  } catch (err) {
    console.error('ERROR:', err);

    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: err.message })
    });

    process.exit(1);
  }
})();
