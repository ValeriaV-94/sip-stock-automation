/**
 * SIP GDU Stock Downloader
 * Flujo: HTTP GET → Cookie → SockJS WebSocket → sessionId + nonce → POST DataTables → Excel → Google Drive
 */

const https = require("https");
const WebSocket = require("ws");
const XLSX = require("xlsx");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ─── Configuración ────────────────────────────────────────────────────────────
const CONFIG = {
  hostname: "sip.gdu.com.uy",
  provId: process.env.SIP_PROV_ID || "HI58jTqquqgVrQR",
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  outputDir: process.env.OUTPUT_DIR || "/tmp",
  wsTimeout: 30000,
  fetchTimeout: 60000,
};

// ─── Utilidades ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function getDates() {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  return {
    fechaDesde: formatDate(yesterday),
    fechaHasta: formatDate(today),
    label: formatDate(yesterday),
  };
}

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ body, headers: res.headers, statusCode: res.statusCode })
      );
    });
    req.setTimeout(CONFIG.fetchTimeout, () => {
      req.destroy();
      reject(new Error("HTTP GET timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        ...options,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          ...options.headers,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ body: data, headers: res.headers, statusCode: res.statusCode })
        );
      }
    );
    req.setTimeout(CONFIG.fetchTimeout, () => {
      req.destroy();
      reject(new Error("HTTP POST timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Paso 1: Obtener Cookie inicial ───────────────────────────────────────────
async function getCookie() {
  log("Paso 1: GET inicial para obtener cookie de sesión...");

  const res = await httpsGet({
    hostname: CONFIG.hostname,
    path: `/SIP/?provID=${CONFIG.provId}`,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
    },
  });

  const rawCookies = res.headers["set-cookie"] || [];
  if (!rawCookies.length) {
    throw new Error(
      `No se recibió cookie. Status: ${res.statusCode}. Headers: ${JSON.stringify(res.headers)}`
    );
  }

  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
  log(`Cookie obtenida: ${cookie}`);
  return cookie;
}

// ─── Paso 2: SockJS Info ──────────────────────────────────────────────────────
async function getSockJSInfo(cookie) {
  log("Paso 2: Consultando SockJS info...");

  const paths = [
    `/SIP/sockjs/info`,
    `/SIP/ws/info`,
    `/SIP/shiny/info`,
  ];

  for (const p of paths) {
    try {
      const res = await httpsGet({
        hostname: CONFIG.hostname,
        path: p,
        headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
      });

      if (res.statusCode === 200 && res.body.includes("websocket")) {
        log(`SockJS info encontrado en: ${p}`);
        return { sockjsPath: p.replace("/info", "") };
      }
    } catch (e) {
      log(`  Path ${p} no disponible: ${e.message}`);
    }
  }

  log("SockJS info no encontrado, usando path por defecto /SIP/sockjs");
  return { sockjsPath: "/SIP/sockjs" };
}

// ─── Paso 3: WebSocket SockJS → sessionId + nonce ────────────────────────────
async function connectShinyWebSocket(cookie, sockjsPath) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `WebSocket timeout (${CONFIG.wsTimeout}ms). No se recibió sessionId de Shiny.`
        )
      );
    }, CONFIG.wsTimeout);

    const serverId = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    const sockSessionId =
      Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 10);

    const wsUrl = `wss://${CONFIG.hostname}${sockjsPath}/${serverId}/${sockSessionId}/websocket`;
    log(`Paso 3: Conectando WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: `https://${CONFIG.hostname}`,
      },
      rejectUnauthorized: false,
    });

    let shinySessionId = null;
    let shinyNonce = null;
    let inputsSent = false;
    const allMessages = [];

    ws.on("open", () => {
      log("  WebSocket abierto. Esperando frame SockJS...");
    });

    ws.on("message", (rawMsg) => {
      const msg = rawMsg.toString();
      allMessages.push(msg.substring(0, 300));

      if (msg === "o") {
        log("  SockJS open frame recibido.");
        return;
      }
      if (msg === "h") return; // heartbeat

      if (msg.startsWith("a")) {
        let frames;
        try {
          frames = JSON.parse(msg.substring(1));
        } catch (e) {
          log(`  Error parseando frame: ${e.message}`);
          return;
        }

        for (const frame of frames) {
          let parsed;
          try {
            parsed = typeof frame === "string" ? JSON.parse(frame) : frame;
          } catch (e) {
            continue;
          }

          log(`  Shiny msg: ${JSON.stringify(parsed).substring(0, 100)}`);

          // sessionId en config
          if (parsed.config && parsed.config.sessionId) {
            shinySessionId = parsed.config.sessionId;
            log(`  ✓ sessionId: ${shinySessionId}`);
          }

          // nonce en distintos lugares
          if (parsed.nonce) { shinyNonce = parsed.nonce; log(`  ✓ nonce (directo): ${shinyNonce}`); }
          if (parsed.custom && parsed.custom.nonce) { shinyNonce = parsed.custom.nonce; log(`  ✓ nonce (custom): ${shinyNonce}`); }
          if (parsed.values && parsed.values.nonce) { shinyNonce = parsed.values.nonce; log(`  ✓ nonce (values): ${shinyNonce}`); }

          // nonce via regex en el mensaje completo
          const nonceInMsg = JSON.stringify(parsed).match(/"nonce"\s*:\s*"([a-f0-9]{8,32})"/i);
          if (nonceInMsg && !shinyNonce) {
            shinyNonce = nonceInMsg[1];
            log(`  ✓ nonce (regex): ${shinyNonce}`);
          }

          // Enviar init cuando tenemos sessionId
          if (shinySessionId && !inputsSent) {
            inputsSent = true;
            log("  Enviando init de sesión Shiny...");
            const initMsg = JSON.stringify({
              method: "init",
              data: {
                ".clientdata_output_Stock_hidden": false,
                ".clientdata_pixelratio": 1,
                ".clientdata_url_protocol": "https:",
                ".clientdata_url_hostname": CONFIG.hostname,
                ".clientdata_url_port": "",
                ".clientdata_url_pathname": "/SIP/",
                ".clientdata_url_search": `?provID=${CONFIG.provId}`,
                ".clientdata_url_hash_initial": "",
                ".clientdata_url_hash": "",
                ".clientdata_singletons": "",
                ".clientdata_allowDataUriScheme": true,
              },
            });
            try {
              ws.send(JSON.stringify([initMsg]));
              log("  Init enviado.");
            } catch (e) {
              log(`  Error enviando init: ${e.message}`);
            }
          }

          if (shinySessionId && shinyNonce) {
            clearTimeout(timeoutHandle);
            ws.close();
            resolve({ sessionId: shinySessionId, nonce: shinyNonce });
            return;
          }
        }
      }

      if (msg.startsWith("c")) {
        if (!shinySessionId) {
          clearTimeout(timeoutHandle);
          reject(new Error(`WebSocket cerrado antes de recibir sessionId.\nMensajes:\n${allMessages.join("\n")}`));
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`WebSocket error: ${err.message}\nMensajes hasta el error:\n${allMessages.join("\n")}`));
    });

    ws.on("close", (code, reason) => {
      if (!shinySessionId) {
        clearTimeout(timeoutHandle);
        reject(new Error(`WebSocket cerrado (code ${code}: ${reason}) sin sessionId.\nMensajes:\n${allMessages.join("\n")}`));
      }
    });
  });
}

// ─── Paso 4: POST DataTables ──────────────────────────────────────────────────
async function fetchStock(sessionId, nonce, cookie, fechaDesde, fechaHasta) {
  log(`Paso 4: Consultando stock para ${fechaDesde} ~ ${fechaHasta}...`);

  const bodyParams = [
    "draw=1", "start=0", "length=100000",
    "search%5Bvalue%5D=", "search%5Bregex%5D=false",
    "search%5BcaseInsensitive%5D=true", "search%5Bsmart%5D=true", "escape=true",
    "columns%5B0%5D%5Bdata%5D=0", "columns%5B0%5D%5Bname%5D=Cadena",
    "columns%5B0%5D%5Bsearchable%5D=true", "columns%5B0%5D%5Borderable%5D=true",
    "columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B1%5D%5Bdata%5D=1", "columns%5B1%5D%5Bname%5D=Local",
    "columns%5B1%5D%5Bsearchable%5D=true", "columns%5B1%5D%5Borderable%5D=true",
    "columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B2%5D%5Bdata%5D=2", "columns%5B2%5D%5Bname%5D=Seccion",
    "columns%5B2%5D%5Bsearchable%5D=true", "columns%5B2%5D%5Borderable%5D=true",
    "columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B3%5D%5Bdata%5D=3", "columns%5B3%5D%5Bname%5D=Familia",
    "columns%5B3%5D%5Bsearchable%5D=true", "columns%5B3%5D%5Borderable%5D=true",
    "columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B4%5D%5Bdata%5D=4", "columns%5B4%5D%5Bname%5D=SubFamilia",
    "columns%5B4%5D%5Bsearchable%5D=true", "columns%5B4%5D%5Borderable%5D=true",
    "columns%5B4%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B4%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B5%5D%5Bdata%5D=5", "columns%5B5%5D%5Bname%5D=Producto",
    "columns%5B5%5D%5Bsearchable%5D=true", "columns%5B5%5D%5Borderable%5D=true",
    "columns%5B5%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B5%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B6%5D%5Bdata%5D=6", "columns%5B6%5D%5Bname%5D=EAN",
    "columns%5B6%5D%5Bsearchable%5D=true", "columns%5B6%5D%5Borderable%5D=true",
    "columns%5B6%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B6%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B7%5D%5Bdata%5D=7", "columns%5B7%5D%5Bname%5D=Stock",
    "columns%5B7%5D%5Bsearchable%5D=true", "columns%5B7%5D%5Borderable%5D=true",
    "columns%5B7%5D%5Bsearch%5D%5Bvalue%5D=", "columns%5B7%5D%5Bsearch%5D%5Bregex%5D=false",
    "columns%5B8%5D%5Bdata%5D=8", "columns%5B8%5D%5Bname%5D=Fecha",
    "columns%5B8%5D%5Bsearchable%5D=true", "columns%5B8%5D%5Borderable%5D=true",
    `columns%5B8%5D%5Bsearch%5D%5Bvalue%5D=${encodeURIComponent(fechaDesde + "~" + fechaHasta)}`,
    "columns%5B8%5D%5Bsearch%5D%5Bregex%5D=false",
    "order%5B0%5D%5Bcolumn%5D=0", "order%5B0%5D%5Bdir%5D=asc",
  ].join("&");

  const res = await httpsPost(
    {
      hostname: CONFIG.hostname,
      path: `/SIP/session/${sessionId}/dataobj/Stock?w=&nonce=${nonce}`,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `https://${CONFIG.hostname}/SIP/?provID=${CONFIG.provId}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    },
    bodyParams
  );

  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} al consultar stock.\nResponse: ${res.body.substring(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Response no es JSON válido.\nBody: ${res.body.substring(0, 500)}`);
  }

  if (!parsed.data || !Array.isArray(parsed.data)) {
    throw new Error(`Response no contiene .data[].\nKeys: ${Object.keys(parsed).join(", ")}`);
  }

  log(`  ✓ Registros obtenidos: ${parsed.recordsFiltered} de ${parsed.recordsTotal} totales`);
  return parsed;
}

// ─── Paso 5: Generar Excel ────────────────────────────────────────────────────
function generateExcel(data, fechaLabel) {
  log("Paso 5: Generando Excel...");

  const headers = ["Cadena","Local","Sector","Familia","SubFamilia","Producto","EAN","Stock","Fecha"];
  const rows = data.map((row) =>
    row.map((v, i) => (i === 6 ? String(v ?? "") : v ?? ""))
  );

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws["!cols"] = [
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 },
    { wch: 40 }, { wch: 15 }, { wch: 10 }, { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Stock");

  const filename = `stock_${fechaLabel}.xlsx`;
  const filepath = path.join(CONFIG.outputDir, filename);
  XLSX.writeFile(wb, filepath);

  log(`  ✓ Excel generado: ${filepath} (${rows.length} filas)`);
  return { filename, filepath };
}

// ─── Paso 6: Subir a Google Drive ────────────────────────────────────────────
async function uploadToDrive(filepath, filename) {
  log("Paso 6: Subiendo a Google Drive...");

  if (!CONFIG.googleServiceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no configurado");
  if (!CONFIG.googleDriveFolderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID no configurado");

  const serviceAccount = JSON.parse(CONFIG.googleServiceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  const drive = google.drive({ version: "v3", auth });

  const searchRes = await drive.files.list({
    q: `name='${filename}' and '${CONFIG.googleDriveFolderId}' in parents and trashed=false`,
    fields: "files(id, name)",
  });

  const media = {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: fs.createReadStream(filepath),
  };

  let driveFile;
  if (searchRes.data.files && searchRes.data.files.length > 0) {
    const existingId = searchRes.data.files[0].id;
    log(`  Actualizando archivo existente (ID: ${existingId})...`);
    driveFile = await drive.files.update({
      fileId: existingId,
      requestBody: { name: filename },
      media,
      fields: "id, name, webViewLink",
    });
  } else {
    log("  Creando nuevo archivo en Drive...");
    driveFile = await drive.files.create({
      requestBody: { name: filename, parents: [CONFIG.googleDriveFolderId] },
      media,
      fields: "id, name, webViewLink",
    });
  }

  log(`  ✓ Subido: ${driveFile.data.webViewLink}`);
  return driveFile.data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  log("=== SIP Stock Downloader iniciado ===");

  const { fechaDesde, fechaHasta, label } = getDates();
  log(`Rango de fechas: ${fechaDesde} ~ ${fechaHasta}`);

  try {
    const cookie = await getCookie();
    const { sockjsPath } = await getSockJSInfo(cookie);
    const { sessionId, nonce } = await connectShinyWebSocket(cookie, sockjsPath);

    log(`SessionId: ${sessionId}`);
    log(`Nonce: ${nonce}`);

    const stockData = await fetchStock(sessionId, nonce, cookie, fechaDesde, fechaHasta);
    const { filename, filepath } = generateExcel(stockData.data, label);
    const driveFile = await uploadToDrive(filepath, filename);

    fs.unlinkSync(filepath);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result = {
      success: true,
      records: stockData.recordsFiltered,
      filename,
      driveId: driveFile.id,
      driveUrl: driveFile.webViewLink,
      fechaDesde,
      fechaHasta,
      elapsedSeconds: elapsed,
    };

    log("=== Completado ===");
    log(JSON.stringify(result, null, 2));
    console.log("N8N_OUTPUT:" + JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    const errorResult = { success: false, error: err.message, stack: err.stack };
    log("=== ERROR ===");
    log(err.message);
    console.error("N8N_OUTPUT:" + JSON.stringify(errorResult));
    process.exit(1);
  }
}

main();
