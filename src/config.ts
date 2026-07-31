/**
 * Configuración central del scraper.
 *
 * Todos los valores tienen un default razonable pensado para no saturar el
 * servidor.
 */
import * as path from 'path';

export interface AppConfig {
  /** URL base del recurso JSF a scrapear. */
  baseUrl: string;
  /** Prefijo (namingContainer) del formulario JSF. */
  formId: string;
  /** Id del componente DataTable dentro del formulario. */
  dataTableId: string;
  /** Filas por página que reporta el servidor (fijo por el sitio). */
  rowsPerPage: number;

  /** Carpeta raíz de salida. */
  outputDir: string;
  /** Carpeta de PDFs. */
  pdfDir: string;
  /** Ruta del JSON con los metadatos extraídos. */
  dataJsonPath: string;
  /** Ruta del CSV con los metadatos extraídos. */
  dataCsvPath: string;
  /** Ruta del registro de descargas fallidas (para reintentos). */
  failedPath: string;

  /** Delay base (ms) entre requests para no saturar el servidor. */
  requestDelayMs: number;
  /** Delay extra (ms) entre descargas de PDF. */
  pdfDelayMs: number;
  /** Timeout por request (ms). */
  timeoutMs: number;

  /** Máximo de reintentos ante 429 / errores transitorios. */
  maxRetries: number;
  /** Backoff base (ms) para el retroceso exponencial. */
  backoffBaseMs: number;
  /** Tope máximo (ms) de espera entre reintentos. */
  backoffMaxMs: number;

  /** User-Agent enviado en todas las peticiones. */
  userAgent: string;

  // --- Límites de ejecución (útiles para pruebas) ---
  /** Número máximo de páginas a recorrer (undefined = todas). */
  maxPages?: number;
  /** Número máximo de PDFs a descargar (undefined = todos). */
  maxPdfs?: number;
  /** Si es false, solo extrae metadatos y no descarga PDFs. */
  downloadPdfs: boolean;
  /** Si es true, solo reintenta las descargas del registro de fallidas. */
  retryFailed: boolean;
}

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

/**
 * Configuración por defecto apuntando al sitio OEFA (público, sin VPN).
 * Para el sitio del Poder Judicial (requiere VPN a Perú) basta con cambiar
 * `baseUrl`, `formId` y `dataTableId` — la mecánica JSF/PrimeFaces es análoga.
 */
export const DEFAULT_CONFIG: AppConfig = {
  baseUrl: 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml',
  formId: 'listarDetalleInfraccionRAAForm',
  dataTableId: 'listarDetalleInfraccionRAAForm:dt',
  rowsPerPage: 10,

  outputDir: OUTPUT_DIR,
  pdfDir: path.join(OUTPUT_DIR, 'pdfs'),
  dataJsonPath: path.join(OUTPUT_DIR, 'documentos.json'),
  dataCsvPath: path.join(OUTPUT_DIR, 'documentos.csv'),
  failedPath: path.join(OUTPUT_DIR, 'descargas_fallidas.json'),

  requestDelayMs: 800,
  pdfDelayMs: 1200,
  timeoutMs: 60_000,

  maxRetries: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  downloadPdfs: true,
  retryFailed: false,
};
