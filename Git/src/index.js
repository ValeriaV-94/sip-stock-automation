/**
 * SIP GDU Stock Downloader
 * ---------------------------------------------------------------------------
 * Flujo:
 *   1. GET HTML inicial            -> cookie de sesion HTTP + deteccion del
 *                                      id del input de rango de fechas
 *   2. WebSocket (protocolo SockJS)-> handshake Shiny -> sessionId + nonce
 *   3. Se setea el input de fechas vía WS (igual que hace el navegador)
 *   4. POST paginado a /session/{sessionId}/dataobj/Stock?nonce=...
 *   5. Se arma el .xlsx con la libreria "xlsx"
 *   6. Se sube a Google Drive con Service Account
 *   7. Se notifica a n8n via webhook (si esta configurado)
 *
 * IMPORTANTE sobre el WebSocket:
 *   No conocemos a ciegas el path exacto que usa este deploy de Shiny Server
 *   para el upgrade de WebSocket (puede ser "/SIP/websocket/" directo, o
 *   "/SIP/sockjs/{server}/{session}/websocket" via SockJS). Por eso esta
 *   version PRUEBA varios patrones conocidos en orden y se queda con el
 *   primero que devuelva un frame "o" (open) valido de SockJS. Esto evita
 *   tener que volver a capturar trafico: el propio script "descubre" cual
 *   funciona y lo deja loggeado en la consola de GitHub Actions.
 * ---------------------------------------------------------------------------
 */

const fetch = require("node-fetch");
const WebSocket = require("ws");
const XLSX = require("xlsx");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  baseUrl: process.env.GDU_BASE_URL || "https://sip.gdu.com.uy/SIP/",
  provId: process.env.GDU_PROV_ID || "HI58jTqquqgVrQR",
  dateFrom: process.env.TARGET_DATE_FROM || null, // YYYY-MM-DD, si no viene se calcula
  dateTo: process.env.TARGET_DATE_TO || null, // YYYY-MM-DD
  driveFolderId: process.env.GDRIVE_FOLDER_ID || "",
  googleSaJsonB64: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
  n8nCallbackUrl: process.env.N8N_CALLBACK_URL || "",
  n8nCallbackToken: process.env.N8N_CALLBACK_TOKEN || "",
  // Nombres de columnas conocidos del Excel manual. Si no se definen,
  // se usan nombres genericos Col1..ColN (no rompe nada, solo cambia el
  // encabezado del Excel). Se puede setear sin tocar codigo.
  stockColumns: (process.env.STOCK_COLUMNS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pageSize: parseInt(process.env.STOCK_PAGE_SIZE || "2000", 10),
  wsHandshakeTimeoutMs: parseInt(process.env.WS_TIMEOUT_MS || "20000", 10),
  dryRun: process.argv.includes("--dry-run"),
};

const isHttps = CONFIG.baseUrl.startsWith("https://");
const HOST = CONFIG.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
const PATHNAME = "/" + CONFIG.baseUrl.replace(/^https?:\/\/[^/]+\//, "");

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// FECHAS (replica la regla manual: dia anterior, y si hoy es lunes
// se descarga sabado+domingo)
// ============================================================================

function calcularRangoFechas() {
  if (CONFIG.dateFrom && CONFIG.dateTo) {
    return { from: CONFIG.dateFrom, to: CONFIG.dateTo };
  }
  const hoy = new Date();
  const diaSemana = hoy.getDay(); // 0=domingo, 1=lunes...
  const fmt = (d) => d.toISOString().slice(0, 10);

  if (diaSemana === 1) {
    // Lunes -> sabado y domingo
    const sabado = new Date(hoy);
    sabado.setDate(hoy.getDate() - 2);
    const domingo = new Date(hoy);
    domingo.setDate(hoy.getDate() - 1);
    return { from: fmt(sabado), to: fmt(domingo) };
  }

  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  return { from: fmt(ayer), to: fmt(ayer) };
}

// ============================================================================
// PASO 1: HTML inicial + cookie
// ============================================================================

async function fetchInitialPage() {
  const url = `${CONFIG.baseUrl}?provID=${CONFIG.provId}`;
  log(`GET inicial: ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SipStockBot/2.0)",
      Accept: "text/html",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`GET inicial fallo con status ${res.status}`);
  }

  const rawSetCookie = res.headers.raw()["set-cookie"] || [];
  const cookieHeader = rawSetCookie
    .map((c) => c.split(";")[0])
    .join("; ");

  if (!cookieHeader) {
    throw new Error(
      "El GET inicial no devolvio ninguna cookie (Set-Cookie vacio). " +
        "Sin cookie de sesion HTTP el WebSocket va a ser rechazado."
    );
  }

  const html = await res.text();
  log(`Cookie obtenida: ${cookieHeader.substring(0, 60)}...`);
  return { html, cookieHeader };
}

// ============================================================================
// PASO 2: detectar el id del input de rango de fechas dentro del HTML
// (los widgets de Shiny SI estan en el HTML estatico, lo que no esta
// es su VALOR dinamico, que se setea por WS)
// ============================================================================

function extractDateInputId(html) {
  const patterns = [
    /id="([^"]+)"[^>]*class="[^"]*shiny-date-range-input/i,
    /class="[^"]*shiny-date-range-input[^"]*"[^>]*id="([^"]+)"/i,
    /id="([^"]+)"[^>]*class="[^"]*date-range-input/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  // Fallback: candidatos tipicos por si el regex de clase no matcheo
  const fallbackCandidates = ["fechas", "rango_fechas", "daterange", "dateRange", "filtro_fechas"];
  for (const candidate of fallbackCandidates) {
    if (html.includes(`id="${candidate}"`)) return candidate;
  }
  return null; // se maneja mas adelante: si es null, no se manda update de fecha
}

// ============================================================================
// PASO 3: candidatos de URL de WebSocket
// ============================================================================

function buildCandidateWsUrls() {
  const proto = isHttps ? "wss" : "ws";
  const serverId = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const sessId = crypto.randomBytes(4).toString("hex"); // 8 chars, estilo sockjs-client

  return [
    `${proto}://${HOST}${PATHNAME}websocket/`,
    `${proto}://${HOST}${PATHNAME}sockjs/${serverId}/${sessId}/websocket`,
    `${proto}://${HOST}${PATHNAME}__sockjs__/${serverId}/${sessId}/websocket`,
  ];
}

// ============================================================================
// PASO 4: handshake Shiny sobre SockJS -> sessionId + nonce
// ============================================================================

function intentarConexionWs(wsUrl, cookieHeader, dateInputId, fechas) {
  return new Promise((resolve, reject) => {
    let shinySessionId = null;
    let shinyNonce = null;
    let initEnviado = false;
    let fechaEnviada = false;
    let resuelto = false;
    const mensajesLog = [];

    log(`Probando WS: ${wsUrl}`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookieHeader,
        Origin: `https://${HOST}`,
        "User-Agent": "Mozilla/5.0 (compatible; SipStockBot/2.0)",
      },
      handshakeTimeout: 8000,
    });

    const timeoutHandle = setTimeout(() => {
      if (!resuelto) {
        resuelto = true;
        ws.terminate();
        reject(
          new Error(
            `Timeout esperando sessionId/nonce en ${wsUrl}.\nUltimos mensajes:\n${mensajesLog
              .slice(-10)
              .join("\n")}`
          )
        );
      }
    }, CONFIG.wsHandshakeTimeoutMs);

    function finalizarOk() {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(timeoutHandle);
      ws.close();
      resolve({ sessionId: shinySessionId, nonce: shinyNonce, wsUrlUsado: wsUrl });
    }

    function enviarInit() {
      const initData = {
        ".clientdata_output_Stock_hidden": false,
        ".clientdata_pixelratio": 1,
        ".clientdata_url_protocol": isHttps ? "https:" : "http:",
        ".clientdata_url_hostname": HOST.split(":")[0],
        ".clientdata_url_port": HOST.includes(":") ? HOST.split(":")[1] : "",
        ".clientdata_url_pathname": PATHNAME,
        ".clientdata_url_search": `?provID=${CONFIG.provId}`,
        ".clientdata_url_hash_initial": "",
        ".clientdata_url_hash": "",
        ".clientdata_singletons": "",
        ".clientdata_allowDataUriScheme": true,
      };
      const frame = JSON.stringify(["INIT::" + JSON.stringify({ method: "init", data: initData })]);
      // Formato real de envio Shiny/SockJS: un array JSON con un string JSON adentro
      const payload = JSON.stringify([JSON.stringify({ method: "init", data: initData })]);
      ws.send(payload);
      log("  -> init enviado");
    }

    function enviarFechas() {
      if (!dateInputId) {
        log("  (no se detecto input de fecha en el HTML, se omite seteo de rango)");
        fechaEnviada = true;
        return;
      }
      const updateMsg = {
        method: "update",
        data: { [dateInputId]: [fechas.from, fechas.to] },
      };
      ws.send(JSON.stringify([JSON.stringify(updateMsg)]));
      log(`  -> rango de fechas enviado (${dateInputId}: ${fechas.from} a ${fechas.to})`);
      fechaEnviada = true;
    }

    ws.on("open", () => {
      log("  WS abierto (handshake TCP/TLS ok, esperando frame SockJS 'o')");
    });

    ws.on("message", (data) => {
      const msg = data.toString();
      mensajesLog.push(msg.substring(0, 200));

      if (msg === "h") return; // heartbeat sockjs
      if (msg.startsWith("o")) {
        log("  Frame 'o' (open) recibido de SockJS");
        return;
      }
      if (msg.startsWith("c")) {
        log(`  Frame 'c' (close) recibido: ${msg}`);
        if (!shinySessionId && !resuelto) {
          resuelto = true;
          clearTimeout(timeoutHandle);
          reject(new Error(`Servidor cerro el WS antes de tiempo en ${wsUrl}: ${msg}`));
        }
        return;
      }
      if (!msg.startsWith("a")) return;

      let frames;
      try {
        frames = JSON.parse(msg.substring(1));
      } catch (e) {
        return;
      }

      for (const frame of frames) {
        let parsed;
        try {
          parsed = typeof frame === "string" ? JSON.parse(frame) : frame;
        } catch (e) {
          continue;
        }

        log(`  Shiny msg: ${JSON.stringify(parsed).substring(0, 150)}`);

        if (parsed.config && parsed.config.sessionId) {
          shinySessionId = parsed.config.sessionId;
          log(`  sessionId encontrado: ${shinySessionId}`);
          if (!initEnviado) {
            initEnviado = true;
            enviarInit();
          }
        }

        if (parsed.nonce) shinyNonce = parsed.nonce;
        if (parsed.custom && parsed.custom.nonce) shinyNonce = parsed.custom.nonce;
        if (parsed.values && parsed.values.nonce) shinyNonce = parsed.values.nonce;
        if (!shinyNonce) {
          const m = JSON.stringify(parsed).match(/"nonce"\s*:\s*"([a-f0-9]{6,32})"/i);
          if (m) shinyNonce = m[1];
        }

        // Una vez que Shiny terminó de inicializar (mensaje de "busy"/"idle"
        // o cualquier mensaje posterior al init), mandamos el rango de fechas.
        if (initEnviado && !fechaEnviada) {
          enviarFechas();
        }

        if (shinySessionId && shinyNonce) {
          finalizarOk();
          return;
        }
      }
    });

    ws.on("error", (err) => {
      if (!resuelto) {
        resuelto = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`WS error en ${wsUrl}: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!resuelto) {
        resuelto = true;
        clearTimeout(timeoutHandle);
        reject(
          new Error(
            `WS cerrado sin completar handshake en ${wsUrl}.\nMensajes:\n${mensajesLog
              .slice(-10)
              .join("\n")}`
          )
        );
      }
    });
  });
}

async function obtenerSessionIdYNonce(cookieHeader, dateInputId, fechas) {
  const candidatos = buildCandidateWsUrls();
  const errores = [];

  for (const url of candidatos) {
    try {
      const resultado = await intentarConexionWs(url, cookieHeader, dateInputId, fechas);
      log(`>>> WS exitoso usando: ${resultado.wsUrlUsado}`);
      return resultado;
    } catch (e) {
      log(`  Fallo candidato: ${e.message.split("\n")[0]}`);
      errores.push(`${url} -> ${e.message}`);
    }
  }

  throw new Error(
    "Ningun patron de WebSocket funciono. Detalle de cada intento:\n\n" + errores.join("\n\n")
  );
}

// ============================================================================
// PASO 5: descarga paginada del Stock via DataTables endpoint
// ============================================================================

function buildDataTablesParams({ draw, start, length, numCols }) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  for (let i = 0; i < numCols; i++) {
    params.set(`columns[${i}][data]`, String(i));
    params.set(`columns[${i}][name]`, "");
    params.set(`columns[${i}][searchable]`, "true");
    params.set(`columns[${i}][orderable]`, "false");
    params.set(`columns[${i}][search][value]`, "");
    params.set(`columns[${i}][search][regex]`, "false");
  }
  params.set("start", String(start));
  params.set("length", String(length));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  return params;
}

async function fetchAllStockRows({ sessionId, nonce, cookieHeader }) {
  const endpoint = `${CONFIG.baseUrl}session/${sessionId}/dataobj/Stock?w=&nonce=${nonce}`;
  log(`POST stock endpoint: ${endpoint}`);

  // Probe inicial con 1 columna generica para descubrir cuantas columnas
  // tiene realmente la respuesta (data[0].length) y el total de registros.
  const probeParams = buildDataTablesParams({ draw: 1, start: 0, length: 1, numCols: 1 });
  const probeRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: probeParams.toString(),
  });

  if (!probeRes.ok) {
    throw new Error(`Probe a dataobj/Stock fallo con status ${probeRes.status}`);
  }

  const probeJson = await probeRes.json();
  const recordsTotal = probeJson.recordsTotal || 0;
  const numCols = (probeJson.data && probeJson.data[0] && probeJson.data[0].length) || 1;

  log(`recordsTotal=${recordsTotal} numCols=${numCols}`);

  if (recordsTotal === 0) {
    return { rows: [], numCols };
  }

  const allRows = [];
  let start = 0;
  let draw = 2;
  const pageSize = CONFIG.pageSize;
  const maxIter = Math.ceil(recordsTotal / pageSize) + 2;
  let iter = 0;

  while (start < recordsTotal && iter < maxIter) {
    iter++;
    const params = buildDataTablesParams({ draw, start, length: pageSize, numCols });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`Pagina start=${start} fallo con status ${res.status}`);
    }

    const json = await res.json();
    const pageRows = json.data || [];
    allRows.push(...pageRows);
    log(`  pagina start=${start}: ${pageRows.length} filas (acumulado ${allRows.length}/${recordsTotal})`);

    if (pageRows.length === 0) break; // evita loop infinito si el server no respeta start/length
    start += pageSize;
    draw++;
    await sleep(250);
  }

  return { rows: allRows, numCols };
}

// ============================================================================
// PASO 6: armar el XLSX
// ============================================================================

function buildWorkbook(rows, numCols) {
  const headers =
    CONFIG.stockColumns.length === numCols
      ? CONFIG.stockColumns
      : Array.from({ length: numCols }, (_, i) => `Col${i + 1}`);

  const sheetData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Stock");
  return wb;
}

// ============================================================================
// PASO 7: subir a Google Drive
// ============================================================================

async function uploadToDrive(filePath, fileName) {
  if (!CONFIG.googleSaJsonB64) {
    throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON (base64 de la key del Service Account).");
  }
  if (!CONFIG.driveFolderId) {
    throw new Error("Falta GDRIVE_FOLDER_ID.");
  }

  const credsJson = JSON.parse(
    Buffer.from(CONFIG.googleSaJsonB64, "base64").toString("utf-8")
  );

  const auth = new google.auth.GoogleAuth({
    credentials: credsJson,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  const drive = google.drive({ version: "v3", auth });

  log(`Subiendo ${fileName} a carpeta Drive ${CONFIG.driveFolderId}...`);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [CONFIG.driveFolderId],
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: fs.createReadStream(filePath),
    },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });

  log(`Subido OK. fileId=${res.data.id}`);
  return res.data;
}

// ============================================================================
// PASO 8: notificar a n8n
// ============================================================================

async function notifyN8n(payload) {
  if (!CONFIG.n8nCallbackUrl) {
    log("N8N_CALLBACK_URL no configurado, se omite notificacion.");
    return;
  }
  try {
    await fetch(CONFIG.n8nCallbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CONFIG.n8nCallbackToken
          ? { Authorization: `Bearer ${CONFIG.n8nCallbackToken}` }
          : {}),
      },
      body: JSON.stringify(payload),
    });
    log("Notificacion a n8n enviada.");
  } catch (e) {
    log(`No se pudo notificar a n8n: ${e.message}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const fechas = calcularRangoFechas();
  log(`Rango de fechas a descargar: ${fechas.from} -> ${fechas.to}`);
  log(`Modo dry-run: ${CONFIG.dryRun}`);

  const { html, cookieHeader } = await fetchInitialPage();
  const dateInputId = extractDateInputId(html);
  log(`Input de fecha detectado en HTML: ${dateInputId || "(ninguno, se omite seteo de rango)"}`);

  const { sessionId, nonce } = await obtenerSessionIdYNonce(cookieHeader, dateInputId, fechas);
  log(`sessionId=${sessionId} nonce=${nonce}`);

  const { rows, numCols } = await fetchAllStockRows({ sessionId, nonce, cookieHeader });
  log(`Total filas descargadas: ${rows.length}`);

  const fileName = `stock_${fechas.to.replace(/-/g, "_")}.xlsx`;
  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, fileName);

  const wb = buildWorkbook(rows, numCols);
  XLSX.writeFile(wb, filePath);
  log(`Excel generado: ${filePath}`);

  if (CONFIG.dryRun) {
    log("Dry-run: se omite la subida a Google Drive y la notificacion a n8n.");
    return;
  }

  const driveFile = await uploadToDrive(filePath, fileName);

  await notifyN8n({
    status: "ok",
    fileName,
    driveFileId: driveFile.id,
    driveFileLink: driveFile.webViewLink,
    rows: rows.length,
    dateFrom: fechas.from,
    dateTo: fechas.to,
  });

  log("Proceso completado OK.");
}

main().catch(async (err) => {
  log(`ERROR FATAL: ${err.message}`);
  console.error(err);
  await notifyN8n({ status: "error", message: err.message }).catch(() => {});
  process.exit(1);
});
