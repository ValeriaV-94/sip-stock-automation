const { chromium } = require('playwright');

async function main() {
  const targetDate = process.env.TARGET_DATE; // YYYY-MM-DD
  const webhookUrl = process.env.N8N_WEBHOOK_URL;

  if (!targetDate) throw new Error('TARGET_DATE no definida');
  if (!webhookUrl) throw new Error('N8N_WEBHOOK_URL no definida');

  console.log(`Iniciando scraping para fecha: ${targetDate}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // === PASO 1: Interceptar sessionId del tráfico de red ===
  // Shiny expone el sessionId en las URLs de sus requests HTTP post-WebSocket.
  // Es más confiable que leerlo de JS porque aparece en el primer request HTTP real.
  let sessionId = null;
  let sessionCookies = null;

  page.on('request', (request) => {
    const url = request.url();
    // El patrón es /SIP/session/{32-char-token}/
    const match = url.match(/\/SIP\/session\/([a-zA-Z0-9]+)\//);
    if (match && !sessionId) {
      sessionId = match[1];
      console.log(`SessionId capturado: ${sessionId}`);
    }
  });

  // === PASO 2: Cargar la app y esperar inicialización de Shiny ===
  console.log('Cargando portal SIP...');
  await page.goto('https://sip.gdu.com.uy/SIP/', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  // Esperar que Shiny esté conectado (no solo que el HTML cargue)
  // Shiny.shinyapp.isConnected() es el indicador definitivo
  console.log('Esperando que Shiny inicialice WebSocket...');
  await page.waitForFunction(
    () =>
      typeof window.Shiny !== 'undefined' &&
      typeof window.Shiny.shinyapp !== 'undefined' &&
      window.Shiny.shinyapp.isConnected() === true,
    { timeout: 30000 }
  );
  console.log('Shiny conectado.');

  // === PASO 3: Descubrir IDs de inputs de fecha ===
  // Esto resuelve el problema de no saber los IDs sin el código R fuente.
  const allInputIds = await page.evaluate(() => {
    return Object.keys(window.Shiny.shinyapp.$inputValues || {});
  });
  console.log('Todos los input IDs encontrados en Shiny:', allInputIds);

  // Filtrar los que parecen inputs de fecha
  const dateInputIds = allInputIds.filter((id) => {
    const lower = id.toLowerCase();
    return (
      lower.includes('fech') ||
      lower.includes('date') ||
      lower.includes('inicio') ||
      lower.includes('fin') ||
      lower.includes('start') ||
      lower.includes('end') ||
      lower.includes('desde') ||
      lower.includes('hasta')
    );
  });
  console.log('Inputs de fecha detectados:', dateInputIds);

  // === PASO 4: Setear fechas directamente vía API de Shiny ===
  // CRÍTICO: NO usar page.fill() ni page.type() en inputs de Shiny.
  // Shiny tiene su propio sistema reactivo; hay que notificarle vía setInputValue.
  // {priority: 'event'} fuerza el re-cómputo aunque el valor no cambie.
  await page.evaluate(
    ({ date, ids }) => {
      ids.forEach((id) => {
        window.Shiny.setInputValue(id, date, { priority: 'event' });
        console.log(`Shiny input seteado: ${id} = ${date}`);
      });
    },
    { date: targetDate, ids: dateInputIds }
  );

  // === PASO 5: Esperar que Shiny termine de procesar ===
  // .shiny-busy aparece mientras Shiny está computando en el servidor R.
  // Cuando desaparece, los outputs están listos.
  console.log('Esperando que Shiny procese los inputs...');
  await page.waitForFunction(
    () => !document.querySelector('.shiny-busy'),
    { timeout: 45000 }
  );
  // Buffer adicional para que el download button esté activo
  await page.waitForTimeout(2000);
  console.log('Shiny terminó de procesar.');

  // === PASO 6: Obtener cookies para HTTP directo ===
  const cookies = await context.cookies();
  sessionCookies = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // === PASO 7: Encontrar el botón/link de descarga ===
  // En Shiny, downloadButton() genera un <a class="shiny-download-link">.
  // Su href se llena cuando el output está listo.
  const downloadInfo = await page.evaluate(() => {
    // Buscar todos los elementos de descarga de Shiny
    const links = Array.from(
      document.querySelectorAll('a.shiny-download-link, a[download], button[id*="download"], a[id*="descarg"], button[id*="descarg"]')
    );
    return links.map((el) => ({
      id: el.id,
      text: el.textContent.trim(),
      href: el.href || '',
      tagName: el.tagName,
    }));
  });
  console.log('Elementos de descarga encontrados:', downloadInfo);

  let csvBuffer = null;

  // Estrategia A: Descarga vía endpoint Shiny directo (más confiable)
  // Si tenemos sessionId y el ID del botón de descarga, podemos ir directo
  if (sessionId && downloadInfo.length > 0) {
    // Tomar el primer link de descarga
    const downloadId = downloadInfo[0].id;
    const downloadUrl = `https://sip.gdu.com.uy/SIP/session/${sessionId}/download/${downloadId}`;
    console.log(`Descargando directo desde: ${downloadUrl}`);

    const response = await fetch(downloadUrl, {
      headers: {
        Cookie: sessionCookies,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!response.ok) {
      throw new Error(`Download HTTP ${response.status}: ${await response.text()}`);
    }

    csvBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`CSV descargado: ${csvBuffer.length} bytes`);
  }
  // Estrategia B: Fallback — click en el botón y capturar el evento download
  else {
    console.log('Fallback: intentando click en botón de descarga...');

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

    // Intentar múltiples selectores
    const selectors = [
      'a.shiny-download-link',
      'button:has-text("Descargar")',
      'a:has-text("Descargar")',
      'button:has-text("CSV")',
      'a:has-text("CSV")',
      '[id*="download"]',
      '[id*="descarg"]',
    ];

    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          console.log(`Click exitoso en: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    if (!clicked) {
      // Tomar screenshot para debug y fallar con info útil
      await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
      throw new Error(
        'No se encontró botón de descarga. Screenshot guardado. ' +
        'Revisá debug_screenshot.png y los IDs logueados para ajustar selectores.'
      );
    }

    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    csvBuffer = Buffer.concat(chunks);
    console.log(`CSV descargado via click: ${csvBuffer.length} bytes`);
  }

  await browser.close();

  // === PASO 8: Enviar CSV al webhook de n8n ===
  console.log(`Enviando CSV al webhook n8n: ${webhookUrl}`);
  const payload = {
    filename: `Stock_${targetDate}.csv`,
    mimeType: 'text/csv',
    data: csvBuffer.toString('base64'),
  };

  const webhookResponse = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!webhookResponse.ok) {
    const body = await webhookResponse.text();
    throw new Error(`Webhook falló ${webhookResponse.status}: ${body}`);
  }

  console.log('✅ Proceso completado exitosamente.');
}

main().catch((err) => {
  console.error('❌ Error fatal:', err.message);
  process.exit(1);
});
