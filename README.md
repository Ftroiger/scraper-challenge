# Scraper — Repositorio Digital de Resoluciones

Scraper en **TypeScript** que recorre un sitio **JSF + PrimeFaces**, extrae todos
los documentos de la grilla de resultados y descarga los PDFs asociados, con
**manejo de errores 429** (rate limiting) mediante reintentos con *backoff*
exponencial.

Está construido **solo con peticiones HTTP + parsing** (`axios` + `cheerio`),
**sin ninguna automatización de navegador** (nada de Puppeteer / Playwright /
Selenium), tal como exige el desafío.

## Sitio objetivo

| Sitio | URL | Acceso |
|-------|-----|--------|
| **OEFA** | `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | Público, **sin VPN** |

El scraper apunta por defecto al **repositorio digital de OEFA** (Tribunal de
Fiscalización Ambiental), que es público y permite desarrollar y validar sin
VPN. El sitio del Poder Judicial usa la **misma tecnología** (JSF/PrimeFaces con
`ViewState` y grilla `DataTable`), por lo que la misma arquitectura aplica
cambiando la configuración (ver [Adaptar a otro sitio](#adaptar-a-otro-sitio)).

Al momento de escribir esto, OEFA expone **1753 registros** en **176 páginas**.

---

## Instalación

Requisitos: **Node.js ≥ 18**.

```bash
cd scraper-challenge
npm install
```

## Uso

```bash
# Ejecución completa: extrae TODOS los metadatos y descarga TODOS los PDFs
npm run scrape

# Solo metadatos (rápido, no descarga PDFs)
npm run scrape:meta          # equivale a: --no-pdf

# Prueba acotada: 2 páginas y 3 PDFs (recomendado para empezar)
npm run scrape:test          # equivale a: --max-pages 2 --max-pdfs 3

# Reintentar las descargas que fallaron en corridas anteriores
npm run retry                # equivale a: --retry-failed
```

### Flags disponibles

Pasá flags tras `--` (p.ej. `npm run scrape -- --max-pages 5`):

| Flag | Descripción |
|------|-------------|
| `--no-pdf` | No descarga PDFs, solo extrae metadatos. |
| `--max-pages N` | Límite de páginas a recorrer. |
| `--max-pdfs N` | Límite de PDFs a descargar. |
| `--retry-failed` | Reintenta las descargas del registro de fallidas. |
| `--delay MS` | Delay base entre requests (default `800`). |
| `--url URL` | URL objetivo alternativa. |
| `--help` | Ayuda. |

> **No hace falta descargar todos los PDFs de una sola vez.** El scraper está
> diseñado para poder llegar al final si se lo deja correr: guarda el progreso de
> forma incremental y puede reanudarse. Para la entrega basta con demostrarlo con
> un subconjunto (`npm run scrape:test`).

---

## Salida

Todo se guarda en `output/` (ignorada por git):

```
output/
├── documentos.json          # Metadatos de todos los documentos (JSON)
├── documentos.csv           # Los mismos datos en CSV (con BOM, abre en Excel)
├── descargas_fallidas.json  # Registro de PDFs que fallaron (para reintentar)
└── pdfs/
    ├── RTFA N° 264-2012__153a6d2a.pdf
    ├── Res 007-2016-OEFA-TFA-SEPIM__9c8d4d4a.pdf
    └── ...
```

Cada PDF se nombra con el **nombre real que envía el servidor**
(`Content-Disposition`) más un sufijo con los primeros 8 caracteres del UUID
interno, para garantizar unicidad y trazabilidad.

### Campos extraídos por documento

`nro`, `numeroExpediente`, `administrado`, `unidadFiscalizable`, `sector`,
`nroResolucion`, `uuid`, más metadatos internos (`rowIndex`, `downloadSourceId`,
`page`).

---

## Cómo funciona el scaper

El sitio **no** es HTML estático: es una aplicación **JSF (Mojarra) + PrimeFaces**
con estado en el servidor. No hay URLs por página ni links directos a los PDFs;
todo ocurre por **POST con `ViewState`**. El scraper reproduce ese protocolo:

1. **`GET` inicial** → obtiene la cookie de sesión (`JSESSIONID`) y el token
   **`javax.faces.ViewState`**.
2. **`POST` AJAX "Buscar"** (`btnBuscar`) → devuelve la primera página de la
   grilla y el total de registros (`rowCount`). Es una respuesta *partial-response*
   XML de PrimeFaces.
3. **`POST` AJAX de paginación** del `DataTable` (`dt_pagination`, `dt_first`,
   `dt_rows`) → navega a cualquier página. El `ViewState` se **refresca en cada
   respuesta** y se reutiliza en la siguiente petición.
4. **Parsing de filas** con `cheerio`. Cada fila trae un enlace
   `mojarra.jsfcljs(...)` con el **`param_uuid`** del PDF y el id del componente
   que dispara la descarga.
5. **`POST` de descarga** (formulario clásico, no-AJAX) con ese `param_uuid` →
   el servidor responde `application/octet-stream` con el PDF y su nombre en
   `Content-Disposition`.

### Detalles finos resueltos

- **Filas huérfanas en paginación:** la respuesta de paginación devuelve
  fragmentos `<tr>` *sin* `<table>` contenedor. El parser HTML descarta los `<tr>`
  huérfanos, así que se envuelven en una tabla antes de parsear
  ([`parser.ts`](src/parser.ts)).
- **Estado de página del servidor:** el id del command link usa el índice de fila
  global (`dt:10:...`), que debe coincidir con la ventana de página activa en el
  servidor. Por eso las descargas de una página se hacen **justo después** de
  cargarla, mientras el `ViewState` apunta a ella ([`scraper.ts`](src/scraper.ts)).
- **Cookies:** se implementa un *cookie jar* propio (sin dependencias extra) para
  mantener `JSESSIONID` a lo largo de la sesión ([`httpClient.ts`](src/httpClient.ts)).

---

## Manejo de errores 429 (rate limiting)

Centralizado en [`httpClient.ts`](src/httpClient.ts). Ante un **429 Too Many
Requests** (o errores transitorios 5xx / red / timeout):

- **Detecta** el 429 y aplica **backoff exponencial con jitter**
  (`base · 2^intento`, con aleatorización para evitar sincronización).
- **Respeta la cabecera `Retry-After`** como piso mínimo de espera cuando el
  servidor la envía.
- **Reintenta** hasta `maxRetries` veces (default 5). Si persiste, **continúa con
  el siguiente documento** en lugar de abortar.
- **Registra** cada descarga fallida en `output/descargas_fallidas.json` con el
  motivo, para poder **reintentarla luego** con `npm run retry`.

Además, se aplican **delays configurables** entre requests (`--delay`) y entre
descargas de PDF, para no sobrecargar el servidor.

---

## Estructura del proyecto

```
src/
├── index.ts          # CLI: parseo de flags y arranque
├── scraper.ts        # Orquestador: recorre páginas e intercala descargas
├── jsfSession.ts     # Protocolo JSF/PrimeFaces (ViewState, búsqueda, paginación)
├── httpClient.ts     # Cliente HTTP: cookie jar + backoff exponencial 429/5xx
├── pdfDownloader.ts  # Descarga de PDFs (nombre, validación, fallidas, skip)
├── parser.ts         # Parsing con cheerio (filas, ViewState, paginación)
├── storage.ts        # Persistencia: JSON, CSV y registro de fallidas
├── logger.ts         # Logging con niveles y timestamp
├── config.ts         # Configuración central
└── types.ts          # Tipos / modelos de datos
```

---

## Adaptar a otro sitio

La lógica JSF/PrimeFaces es genérica. Para apuntar al sitio del Poder Judicial
(u otro análogo), ajustá en [`src/config.ts`](src/config.ts):

- `baseUrl` — la URL `.xhtml` de la consulta.
- `formId` — el id/namingContainer del formulario JSF.
- `dataTableId` — el id del componente `DataTable`.
- Los nombres de columnas en `parseRows` ([`parser.ts`](src/parser.ts)) si el
  esquema de la grilla difiere.

> El sitio del Poder Judicial requiere **VPN a Perú**; sin ella responde `403`.

---

## Scripts npm

| Script | Acción |
|--------|--------|
| `npm run scrape` | Ejecución completa (metadatos + PDFs). |
| `npm run scrape:meta` | Solo metadatos (`--no-pdf`). |
| `npm run scrape:test` | Prueba acotada (2 páginas, 3 PDFs). |
| `npm run retry` | Reintenta descargas fallidas. |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm run typecheck` | Chequeo de tipos sin emitir. |