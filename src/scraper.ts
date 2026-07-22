/**
 * Orquestador principal del scraper.
 *
 * Estrategia clave: las descargas de PDF de una página se hacen JUSTO DESPUÉS
 * de cargar esa página, mientras el estado del DataTable en el servidor (y el
 * ViewState) siguen apuntando a ella. El id del command link usa el índice de
 * fila global (p.ej. dt:10), así que la ventana de página del servidor debe
 * coincidir. Por eso se intercala paginar -> descargar -> paginar.
 */
import { AppConfig } from './config';
import { HttpClient, sleep } from './httpClient';
import { JsfSession } from './jsfSession';
import { logger } from './logger';
import { PdfDownloader } from './pdfDownloader';
import { Storage } from './storage';
import { DocumentRecord, ScrapeSummary } from './types';

export class Scraper {
  private readonly http: HttpClient;
  private readonly storage: Storage;
  private readonly downloader: PdfDownloader;

  constructor(private readonly config: AppConfig) {
    this.http = new HttpClient(config);
    this.storage = new Storage(config);
    this.downloader = new PdfDownloader(this.http, config, this.storage);
  }

  /** Ejecuta el flujo completo (extracción + descarga opcional de PDFs). */
  async run(): Promise<ScrapeSummary> {
    if (this.config.retryFailed) {
      return this.retryFailed();
    }
    return this.fullRun();
  }

  private async fullRun(): Promise<ScrapeSummary> {
    const startedAt = new Date().toISOString();
    const session = new JsfSession(this.http, this.config);

    let totalRecords = 0;
    let totalPages = 0;
    let pagesScraped = 0;
    let pdfsDownloaded = 0;
    let pdfsFailed = 0;

    for await (const { page, totalPages: tp, records } of session.iterateAllPages()) {
      totalPages = tp;
      pagesScraped++;
      this.storage.addRecords(records);
      this.storage.flushData(); // volcado incremental
      totalRecords = this.storage.allRecords.length;

      logger.info(
        `Página ${page}/${this.config.maxPages ?? tp}: ${records.length} registros ` +
          `(acumulado: ${totalRecords}).`,
      );

      if (this.config.downloadPdfs) {
        const remaining =
          this.config.maxPdfs !== undefined
            ? this.config.maxPdfs - pdfsDownloaded
            : undefined;
        if (remaining !== undefined && remaining <= 0) {
          logger.info(`Alcanzado el límite de --max-pdfs (${this.config.maxPdfs}).`);
          // Seguimos extrayendo metadatos aunque ya no descarguemos.
        } else {
          const toDownload =
            remaining !== undefined ? records.slice(0, remaining) : records;
          const { ok, failed } = await this.downloader.downloadMany(
            toDownload,
            () => session.downloadFormBase(),
            (done, total) =>
              logger.debug(`  PDF ${done}/${total} de la página ${page}`),
          );
          pdfsDownloaded += ok;
          pdfsFailed += failed;
        }
      }
    }

    const summary: ScrapeSummary = {
      totalRecords,
      totalPages,
      pagesScraped,
      recordsExtracted: totalRecords,
      pdfsDownloaded,
      pdfsFailed,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    this.logSummary(summary);
    return summary;
  }

  /**
   * Modo reintento: recorre el registro de descargas fallidas, reposiciona el
   * DataTable en la página de cada fila y vuelve a intentar la descarga.
   */
  private async retryFailed(): Promise<ScrapeSummary> {
    const startedAt = new Date().toISOString();
    const pending = this.storage.failedList;
    logger.info(`Modo reintento: ${pending.length} descargas pendientes.`);

    let pdfsDownloaded = 0;
    let pdfsFailed = 0;

    if (pending.length > 0) {
      const session = new JsfSession(this.http, this.config);
      await session.init();
      await session.search();

      // Agrupamos por página para minimizar navegaciones.
      const byPage = new Map<number, typeof pending>();
      for (const f of pending) {
        const arr = byPage.get(f.page) ?? [];
        arr.push(f);
        byPage.set(f.page, arr);
      }

      for (const [page, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
        if (page > 1) {
          await sleep(this.config.requestDelayMs);
          await session.goToPage(page - 1); // 0-based
        }
        const recs: DocumentRecord[] = items.map((f) => ({
          rowIndex: f.rowIndex,
          nro: '',
          numeroExpediente: f.numeroExpediente,
          administrado: '',
          unidadFiscalizable: '',
          sector: '',
          nroResolucion: f.nroResolucion,
          uuid: f.uuid,
          downloadSourceId: f.downloadSourceId,
          page: f.page,
        }));
        const { ok, failed } = await this.downloader.downloadMany(recs, () =>
          session.downloadFormBase(),
        );
        pdfsDownloaded += ok;
        pdfsFailed += failed;
      }
    }

    const summary: ScrapeSummary = {
      totalRecords: this.storage.allRecords.length,
      totalPages: 0,
      pagesScraped: 0,
      recordsExtracted: 0,
      pdfsDownloaded,
      pdfsFailed,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    this.logSummary(summary);
    return summary;
  }

  private logSummary(s: ScrapeSummary): void {
    logger.info('════════════════ RESUMEN ════════════════');
    logger.info(`  Registros extraídos : ${s.recordsExtracted}`);
    logger.info(`  Páginas recorridas  : ${s.pagesScraped}/${s.totalPages || '-'}`);
    logger.info(`  PDFs descargados    : ${s.pdfsDownloaded}`);
    logger.info(`  PDFs fallidos       : ${s.pdfsFailed}`);
    if (s.pdfsFailed > 0) {
      logger.info(`  → Reintentá con: npm run retry`);
    }
    logger.info(`  Datos    : ${this.config.dataJsonPath}`);
    logger.info(`  PDFs     : ${this.config.pdfDir}`);
    logger.info('═════════════════════════════════════════');
  }
}
