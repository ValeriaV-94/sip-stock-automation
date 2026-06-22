# SIP Stock Automation

Descarga diaria del Stock desde `sip.gdu.com.uy` (R Shiny) → Excel → Google Drive,
orquestado por n8n Cloud + GitHub Actions.

## Arquitectura final

```
n8n Cloud (Cron L-S 07:00 ART)
  -> Calcular Fechas (Set/Code)
  -> HTTP Request: repository_dispatch a GitHub Actions
       |
       v
GitHub Actions (run.yml)
  -> npm ci
  -> node src/index.js
       1. GET HTML inicial -> cookie HTTP + detecta input de fecha
       2. WebSocket (SockJS) -> handshake Shiny -> sessionId + nonce
       3. Setea rango de fechas vía WS (igual que el browser)
       4. POST paginado a /session/{id}/dataobj/Stock?nonce=...
       5. Genera stock_YYYY_MM_DD.xlsx
       6. Sube a Google Drive (Service Account)
       7. POST callback a n8n (Webhook)
       |
       v
n8n Webhook node -> recibe {status, fileName, driveFileId, rows}
```

GitHub Actions reemplaza por completo a los nodos viejos `Init Session` y
`Extraer Session`: esos nodos intentaban leer `sessionId` del HTML, que nunca
está ahí. Ahora esa parte la hace `src/index.js` por WebSocket.

---

## 1. Estructura de carpetas

```
sip-stock-automation/
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── .github/
│   └── workflows/
│       └── run.yml
└── src/
    └── index.js
```

Los 6 archivos (`package.json`, `package-lock.json`, `.env.example`,
`.gitignore`, `src/index.js`, `.github/workflows/run.yml`) están adjuntos
abajo en el chat, listos para descargar.

---

## 2. Subir el proyecto a GitHub

```bash
git clone https://github.com/ValeriaV-94/sip-stock-automation.git
cd sip-stock-automation

# Copiar ahí los archivos descargados (pisando lo viejo)
# package.json, package-lock.json, .env.example, .gitignore, src/index.js,
# .github/workflows/run.yml

git add .
git commit -m "Reescritura completa: WebSocket + paginado DataTables + Drive"
git push origin main
```

Si el repo tenía un `.github/workflows/*.yml` viejo con otro nombre,
borralo para que no queden dos workflows corriendo:

```bash
git rm .github/workflows/NOMBRE_VIEJO.yml
git commit -m "Elimino workflow viejo"
git push
```

---

## 3. Google Drive + Service Account (paso a paso)

### 3.1 Crear o reusar el proyecto GCP

Si ya existe `sip-automation-497006` de una sesión anterior, usalo. Si no:

1. https://console.cloud.google.com/projectcreate
2. Nombre: `sip-automation`, anotar el Project ID real que te asigna.

### 3.2 Habilitar la API de Drive

1. https://console.cloud.google.com/apis/library/drive.googleapis.com
2. Seleccionar el proyecto → **Habilitar**.

### 3.3 Crear el Service Account

1. https://console.cloud.google.com/iam-admin/serviceaccounts
2. **Crear cuenta de servicio**
3. Nombre: `sip-bot` → Crear y continuar → Listo (sin roles de proyecto, no hace falta).
4. Anotar el email generado, ej: `sip-bot@TU_PROYECTO.iam.gserviceaccount.com`

### 3.4 Generar la key JSON

1. Entrar a la cuenta de servicio creada → pestaña **Claves**
2. **Agregar clave** → **Crear clave nueva** → **JSON** → Crear
3. Se descarga un archivo `.json`. Guardalo, no se puede volver a descargar.

### 3.5 Convertir la key a base64 (para el Secret de GitHub)

En Mac/Linux/WSL:
```bash
base64 -w 0 ruta/a/sip-bot-key.json > sip-bot-key.b64.txt
```
En Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ruta\sip-bot-key.json")) | Out-File sip-bot-key.b64.txt
```
Abrí `sip-bot-key.b64.txt`, copiá todo el contenido (es una sola línea larga).
Eso va al Secret `GOOGLE_SERVICE_ACCOUNT_JSON`.

### 3.6 Carpeta de destino en Drive — punto crítico

Una Service Account normal tiene **0 bytes de cuota propia** en Drive. Si la
carpeta destino es una carpeta común de un Drive personal, la subida puede
fallar con `storageQuotaExceeded`. Hay dos soluciones, elegí una:

**Opción A — Unidad compartida (recomendada si tenés Google Workspace):**
1. Crear una Unidad compartida ("Shared Drive") en Drive.
2. Agregar como miembro a `sip-bot@TU_PROYECTO.iam.gserviceaccount.com` con
   rol **Administrador de contenido**.
3. Crear ahí la carpeta donde van a caer los Excel. Copiar su ID (de la URL,
   el string después de `/folders/`). Ese ID va en `GDRIVE_FOLDER_ID`.

**Opción B — Cuenta personal sin Workspace:**
1. Crear la carpeta normal en tu Drive personal.
2. Compartirla con `sip-bot@TU_PROYECTO.iam.gserviceaccount.com`,
   permiso **Editor**.
3. El archivo subido va a contar contra la cuota del **dueño de la carpeta**
   (vos), no contra la del bot, así que no debería dar `storageQuotaExceeded`.
   Copiar el ID de la carpeta en `GDRIVE_FOLDER_ID`.

---

## 4. GitHub Secrets (configuración exacta)

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
Crear estos 7 secrets:

| Secret | Valor |
|---|---|
| `GDU_BASE_URL` | `https://sip.gdu.com.uy/SIP/` |
| `GDU_PROV_ID` | `HI58jTqquqgVrQR` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | contenido completo de `sip-bot-key.b64.txt` |
| `GDRIVE_FOLDER_ID` | el ID de carpeta del paso 3.6 |
| `N8N_CALLBACK_URL` | URL del nodo Webhook de n8n (paso 6) |
| `N8N_CALLBACK_TOKEN` | un string random que vos elijas, ej: generado con `openssl rand -hex 16` |
| `STOCK_COLUMNS` | opcional. Vacío = `Col1,Col2,Col3...` en el Excel |

También necesitás un **Personal Access Token** de GitHub para que n8n pueda
disparar el workflow (si no lo tenés ya del intento anterior):

1. https://github.com/settings/tokens?type=beta
2. **Generate new token** → Fine-grained → Repository access: solo
   `ValeriaV-94/sip-stock-automation` → Permissions: **Actions: Read and write**.
3. Copiar el token. Este NO va como GitHub Secret — va hardcodeado en el
   nodo de n8n (ver paso 5), porque es n8n quien lo usa para llamar a la API
   de GitHub.

---

## 5. Workflow de n8n — nodos a eliminar / agregar / conservar

### Eliminar
- `Init Session`
- `Extraer Session`
- `Obtener Stock` (la versión vieja que pegaba directo al endpoint sin
  sessionId válido — ahora esa lógica vive en GitHub Actions)
- `Code in JavaScript` (si tenía el intento de Playwright/parsing HTML)
- `Convert to File` (ya no aplica, el Excel se genera en Node.js)

### Conservar (sin cambios de lógica, revisar timezone)
- `Cron Diario` → Trigger: **Cron**, expresión `0 7 * * 1-6`,
  Timezone: `America/Argentina/Cordoba`
- `Calcular Fechas` → mismo Code node que ya tenías. Asegurate que devuelva
  `dateFrom` y `dateTo` en formato `YYYY-MM-DD` (la lógica sábado+domingo
  los lunes la podés dejar acá O dejar que la calcule el script de Node —
  si la dejás en ambos lados, que coincidan).

### Agregar (nodos nuevos)

**Nodo 1 — `Trigger GitHub Actions`** (tipo: HTTP Request)

| Campo | Valor |
|---|---|
| Method | `POST` |
| URL | `https://api.github.com/repos/ValeriaV-94/sip-stock-automation/dispatches` |
| Authentication | None (header manual abajo) |

Headers:
| Name | Value |
|---|---|
| `Accept` | `application/vnd.github+json` |
| `Authorization` | `Bearer TU_PERSONAL_ACCESS_TOKEN` |
| `X-GitHub-Api-Version` | `2022-11-28` |

Body (JSON, modo "Using JSON"):
```json
{
  "event_type": "run-stock-download",
  "client_payload": {
    "date_from": "{{ $json.dateFrom }}",
    "date_to": "{{ $json.dateTo }}"
  }
}
```
Ajustá `{{ $json.dateFrom }}` / `{{ $json.dateTo }}` a los nombres reales de
campo que devuelve tu nodo `Calcular Fechas`.

Respuesta esperada: status `204` sin body. Si da `404`, el token no tiene
permiso sobre el repo. Si da `422`, el `event_type` no coincide con el
`types:` del `run.yml` (tiene que ser exactamente `run-stock-download`).

**Nodo 2 — `Esperar Resultado`** (tipo: Webhook)

| Campo | Valor |
|---|---|
| HTTP Method | `POST` |
| Path | `sip-stock-callback` (o el que prefieras) |
| Authentication | Header Auth |
| Header Name | `Authorization` |
| Header Value | `Bearer EL_MISMO_VALOR_DE_N8N_CALLBACK_TOKEN` |
| Respond | Immediately, status 200 |

La URL completa de este Webhook (la que te muestra n8n arriba del nodo) es
el valor que va en el Secret `N8N_CALLBACK_URL` de GitHub.

Este Webhook va a recibir, cuando termine la GitHub Action:
```json
{
  "status": "ok",
  "fileName": "stock_2026_06_21.xlsx",
  "driveFileId": "...",
  "driveFileLink": "...",
  "rows": 64346,
  "dateFrom": "2026-06-21",
  "dateTo": "2026-06-21"
}
```
o en error:
```json
{ "status": "error", "message": "..." }
```

**Nodo 3 — `IF status = error`** (opcional, tipo: IF)
Condición: `{{ $json.body.status }}` `equals` `error` → rama true conectada
a tu notificación habitual (Telegram/email); rama false no hace nada más
(el archivo ya está en Drive).

### Conexión final del flujo en n8n
```
Cron Diario -> Calcular Fechas -> Trigger GitHub Actions
                                        (fin de esta rama, no bloquea)

Esperar Resultado (Webhook, trigger independiente)
        -> IF status = error -> notificación
```
El Webhook es un trigger separado: no se conecta en cadena con el Cron, se
dispara solo cuando GitHub Actions hace el POST de vuelta.

---

## 6. Probar todo paso a paso

1. **Local, dry-run** (no sube nada, solo valida que el WS funcione):
   ```bash
   npm install
   cp .env.example .env
   # completar GDU_BASE_URL y GDU_PROV_ID en .env (los demás pueden quedar vacíos)
   npm run dry-run
   ```
   Mirá la consola: tiene que loggear `sessionId=... nonce=...` y
   `Total filas descargadas: N`. Si ningún candidato de WebSocket funciona,
   el error final lista los 3 patrones probados y el motivo de cada fallo —
   pegame ese log si pasa, así ajusto el patrón sin que captures tráfico de nuevo.

2. **GitHub Actions manual:**
   Repo → **Actions** → **SIP Stock Download** → **Run workflow** →
   `dry_run = true` → **Run workflow**. Revisar el log del step
   "Ejecutar descarga de Stock".

3. **GitHub Actions real (sin dry-run):**
   Igual que arriba pero `dry_run = false`. Verificar que aparezca el
   archivo en la carpeta de Drive.

4. **Disparo desde n8n:**
   Ejecutar manualmente el nodo `Trigger GitHub Actions` en n8n → ver que
   se dispare el run en GitHub → esperar el callback en `Esperar Resultado`.

5. **Activar el Cron** una vez que el punto 4 funcionó de punta a punta.

---

## 7. ¿Conviene simplificar esto con scraping (Playwright)?

**No, para este caso puntual.** Análisis concreto:

- **Lo que ya se probó con Playwright falló estructuralmente**, no por un
  bug de configuración: Shiny no dispara el evento de descarga del browser
  de forma estándar (`download.saveAs()` cancelado, `waitForEvent('download')`
  con timeout) porque el botón no genera un `<a download>` real sino que
  Shiny empuja el archivo por una ruta interna ligada al mismo WebSocket.
  Eso significa que aunque arregles el timeout, vas a seguir peleando contra
  el mismo problema de fondo.
- **El endpoint ya devuelve JSON estructurado** (`recordsTotal`,
  `recordsFiltered`, `data[]`). Eso es la mitad del trabajo de un scraper
  hecho gratis: no hay HTML que parsear ni tabla que leer del DOM.
- **Costo/beneficio:** un browser headless (Playwright) en GitHub Actions
  consume ~3-5x más tiempo de cómputo y minutos de Actions que un script
  Node.js puro con `ws` + `fetch`, y es más frágil (depende de selectores
  CSS, de que el render no cambie, de timeouts de render visual). El enfoque
  WebSocket directo es más rápido, más liviano, y más estable a largo plazo
  porque depende del protocolo (que cambia poco) y no del DOM (que cambia
  con cualquier actualización visual de la app).
- **Cuándo SÍ usar Playwright como red de seguridad:** si después de probar
  los 3 patrones de WebSocket del script ninguno conecta (por ejemplo,
  porque el servidor exige un header o cookie adicional que solo aparece
  tras ejecutar JS en un browser real), Playwright pasa a ser la herramienta
  para **una sola tarea**: abrir la página, capturar la URL real del
  WebSocket y la cookie con la que se conecta, e imprimirlos por consola.
  Ahí no se usa Playwright para descargar el archivo, sino solo para
  "espiar" el handshake una vez y volcar esos datos al log — algo bien
  acotado, no todo el pipeline corriendo en un browser cada día.

Conclusión: mantener la arquitectura 100% HTTP/WebSocket (sin Playwright)
como vía principal, y usarlo solo como herramienta de diagnóstico puntual
si el handshake autodetectado falla.

---

## 8. Si el WebSocket no conecta en el primer intento real

El script prueba 3 patrones de URL y loggea cuál funcionó (o por qué falló
cada uno). Si los 3 fallan contra el servidor real, mandame el bloque de log
que empieza en `Ningun patron de WebSocket funciono` — con eso ajusto el
patrón sin pedirte que vuelvas a inspeccionar tráfico manualmente.
