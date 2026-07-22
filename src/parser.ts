/**
 * Parsing de las respuestas del sitio con cheerio.
 *
 * El sitio es JSF + PrimeFaces. Las respuestas AJAX son XML del tipo:
 *   <partial-response><changes>
 *     <update id="...:pgLista"><![CDATA[ ...HTML de la grilla... ]]></update>
 *     <update id="j_id1:javax.faces.ViewState:0"><![CDATA[ nuevo ViewState ]]></update>
 *   </changes></partial-response>
 *
 * Aquí extraemos: ViewState, HTML embebido, filas de la grilla y metadatos de
 * paginación.
 */
import * as cheerio from 'cheerio';
import { DocumentRecord } from './types';

/** Info de paginación que expone el widget DataTable de PrimeFaces. */
export interface PaginationInfo {
  totalRecords: number;
  rowsPerPage: number;
  totalPages: number;
}

/**
 * Extrae el valor de `javax.faces.ViewState`. Funciona tanto en el HTML
 * inicial (input hidden) como en las respuestas AJAX parciales (update CDATA).
 */
export function extractViewState(body: string): string | null {
  // Respuesta AJAX: <update id="...ViewState..."><![CDATA[VALUE]]></update>
  const ajax = body.match(
    /<update id="[^"]*ViewState[^"]*"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
  );
  if (ajax) return ajax[1];

  // HTML inicial: <input ... name="javax.faces.ViewState" ... value="VALUE" />
  const html = body.match(
    /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/,
  );
  if (html) return html[1];

  return null;
}

/**
 * Dado el cuerpo (HTML inicial o AJAX), devuelve un cheerio cargado con el
 * HTML de la grilla. En respuestas AJAX se extrae el contenido del CDATA.
 */
function loadGridHtml(body: string): cheerio.CheerioAPI {
  // Concatenamos todos los bloques <update> (grilla + paginador) si es AJAX.
  const updates = [...body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  const html = updates.length > 0 ? updates.join('\n') : body;
  // IMPORTANTE: la respuesta de paginación devuelve fragmentos <tr> sueltos,
  // sin <table> contenedor. El parser HTML de cheerio descarta los <tr>
  // huérfanos, así que envolvemos todo en una tabla. En la respuesta de
  // búsqueda (que ya trae su <table>), el <div> se reubica y las filas reales
  // se conservan igual.
  return cheerio.load(`<table><tbody>${html}</tbody></table>`, { xml: false });
}

/**
 * Lee la info de paginación desde el script `PrimeFaces.cw("DataTable", ...)`
 * que viaja en la respuesta (contiene rowCount y rows reales del servidor).
 */
export function extractPaginationInfo(
  body: string,
  fallbackRowsPerPage: number,
): PaginationInfo | null {
  const rowCount = body.match(/rowCount:\s*(\d+)/);
  const rows = body.match(/rows:\s*(\d+)/);
  if (!rowCount) return null;

  const totalRecords = Number(rowCount[1]);
  const rowsPerPage = rows ? Number(rows[1]) : fallbackRowsPerPage;
  const totalPages = Math.max(1, Math.ceil(totalRecords / rowsPerPage));
  return { totalRecords, rowsPerPage, totalPages };
}

/** Normaliza espacios y saltos de línea de un texto de celda. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extrae las filas de datos de la grilla PrimeFaces.
 *
 * Cada fila tiene `data-ri` (row index) y, en la última celda, un enlace
 * `mojarra.jsfcljs(...)` con el `param_uuid` del PDF y el id del componente
 * que dispara la descarga.
 */
export function parseRows(body: string, page: number): DocumentRecord[] {
  const $ = loadGridHtml(body);
  const records: DocumentRecord[] = [];

  $('tr[data-ri]').each((_, tr) => {
    const $tr = $(tr);
    const rowIndex = Number($tr.attr('data-ri'));
    const cells = $tr.find('td');
    if (cells.length < 7) return; // fila no válida

    const txt = (i: number) => clean($(cells[i]).text());

    // La última celda contiene el <a onclick="mojarra.jsfcljs(...)">
    const onclick = $(cells[6]).find('a[onclick]').attr('onclick') ?? '';
    const uuid = onclick.match(/'param_uuid'\s*:\s*'([0-9a-fA-F-]{36})'/)?.[1] ?? '';
    const sourceId =
      onclick.match(/\{'([^']*:j_idt\d+)'\s*:/)?.[1] ??
      `${''}`;

    records.push({
      rowIndex,
      nro: txt(0),
      numeroExpediente: txt(1),
      administrado: txt(2),
      unidadFiscalizable: txt(3),
      sector: txt(4),
      nroResolucion: txt(5),
      uuid,
      downloadSourceId: sourceId,
      page,
    });
  });

  return records;
}

/**
 * Extrae el nombre de archivo de una cabecera Content-Disposition.
 * Las cabeceras HTTP se codifican en latin-1, por eso se reinterpretan.
 */
export function filenameFromContentDisposition(cd?: string): string | null {
  if (!cd) return null;
  const match =
    cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i) ?? cd.match(/filename="?([^";]+)"?/i);
  if (!match) return null;
  let name = match[1].trim().replace(/^"|"$/g, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    /* no era URL-encoded */
  }
  return name;
}
