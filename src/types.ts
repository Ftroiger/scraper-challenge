/**
 * Tipos y modelos de datos compartidos por todo el scraper.
 */

/**
 * Un documento (fila de la grilla de resultados) del Tribunal de Fiscalización
 * Ambiental de OEFA. Los nombres de campo reflejan las columnas del sitio.
 */
export interface DocumentRecord {
  /** Índice de fila global usado por PrimeFaces (data-ri). Clave para el download. */
  rowIndex: number;
  /** Número correlativo mostrado en la columna "Nro." */
  nro: string;
  /** Número de expediente administrativo. */
  numeroExpediente: string;
  /** Administrado(s) involucrado(s). */
  administrado: string;
  /** Unidad fiscalizable. */
  unidadFiscalizable: string;
  /** Sector económico. */
  sector: string;
  /** Número de la Resolución de Apelación (RTFA). */
  nroResolucion: string;
  /** UUID interno del archivo PDF (param_uuid del command link). */
  uuid: string;
  /**
   * Identificador del componente JSF que dispara la descarga
   * (p.ej. "listarDetalleInfraccionRAAForm:dt:10:j_idt63").
   */
  downloadSourceId: string;
  /** Página del listado en la que se encontró (1-based). */
  page: number;
}

/** Estado de una descarga de PDF, persistido para reintentos. */
export interface FailedDownload {
  uuid: string;
  nroResolucion: string;
  numeroExpediente: string;
  rowIndex: number;
  downloadSourceId: string;
  page: number;
  reason: string;
  attempts: number;
  lastTriedAt: string;
}

/** Resultado de la ejecución completa del scraper. */
export interface ScrapeSummary {
  totalRecords: number;
  totalPages: number;
  pagesScraped: number;
  recordsExtracted: number;
  pdfsDownloaded: number;
  pdfsFailed: number;
  startedAt: string;
  finishedAt: string;
}
