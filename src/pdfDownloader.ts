/**
 * Descarga de PDFs.
 *
 * Cada PDF se obtiene con un POST "clásico" (no-ajax) al formulario JSF,
 * enviando el `param_uuid` de la fila y el id del command link. El servidor
 * responde con `application/octet-stream` y el nombre real en
 * `Content-Disposition`.
 *
 * El manejo de 429 / backoff exponencial vive en HttpClient; aquí sólo
 * añadimos la lógica de negocio (nombre de archivo, validación, registro de
 * fallidas y skip de ya-descargados).
 */
import { AppConfig } from './config';
import { HttpClient, HttpError, sleep } from './httpClient';
import { logger } from './logger';
import { filenameFromContentDisposition } from './parser';
import { Storage } from './storage';
import { DocumentRecord } from './types';

export class PdfDownloader {
  constructor(
    private readonly http: HttpClient,
    private readonly config: AppConfig,
    private readonly storage: Storage,
  ) {}

  /** Sanea un nombre de archivo para el sistema de archivos. */
  private sanitize(name: string): string {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // caracteres inválidos
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  /**
   * Nombre descriptivo y único: prioriza el nombre del servidor y le antepone
   * el Nro. de resolución/expediente para trazabilidad; cae al uuid si hace
   * falta garantizar unicidad.
   */
  private buildFilename(rec: DocumentRecord, serverName: string | null): string {
    const base = serverName
      ? this.sanitize(serverName.replace(/\.pdf$/i, ''))
      : this.sanitize(rec.nroResolucion || rec.numeroExpediente || rec.uuid);
    const shortUuid = rec.uuid.slice(0, 8);
    return `${base}__${shortUuid}.pdf`;
  }

  /**
   * Descarga el PDF de un registro. Devuelve la ruta si tuvo éxito, o null si
   * falló definitivamente (ya registrado en el listado de fallidas).
   *
   * `downloadFormBase` provee los campos base + ViewState vigente de la sesión.
   */
  async download(
    rec: DocumentRecord,
    downloadFormBase: () => Record<string, string>,
  ): Promise<string | null> {
    if (!rec.uuid) {
      logger.warn(`Registro sin uuid (Nro ${rec.nro}, exp ${rec.numeroExpediente}); se omite.`);
      this.storage.markFailed(rec, 'sin uuid', 0);
      return null;
    }

    // Skip si ya existe un archivo con el nombre esperado por uuid.
    const provisional = this.buildFilename(rec, null);
    if (this.storage.pdfExists(provisional)) {
      logger.debug(`Ya existe ${provisional}; se omite.`);
      this.storage.clearFailed(rec.uuid);
      return provisional;
    }

    const source = rec.downloadSourceId;
    const payload = {
      ...downloadFormBase(),
      [source]: source,
      param_uuid: rec.uuid,
    };
    const data = new URLSearchParams(payload).toString();

    try {
      const res = await this.http.request<ArrayBuffer>({
        method: 'POST',
        url: this.config.baseUrl,
        data,
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.config.baseUrl,
        },
        label: `PDF ${rec.nroResolucion || rec.uuid}`,
      });

      const buf = Buffer.from(res.data);
      const contentType = String(res.headers['content-type'] ?? '');

      // Validación: debe ser binario PDF, no una página HTML de error.
      const looksPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
      if (!looksPdf) {
        const reason = `respuesta no-PDF (content-type=${contentType}, ${buf.length} bytes)`;
        logger.warn(`Descarga inválida de ${rec.uuid}: ${reason}`);
        this.storage.markFailed(rec, reason, this.config.maxRetries);
        return null;
      }

      const serverName = filenameFromContentDisposition(
        res.headers['content-disposition'] as string | undefined,
      );
      const filename = this.buildFilename(rec, serverName);
      const savedAt = this.storage.savePdf(filename, buf);
      this.storage.clearFailed(rec.uuid);
      logger.info(`✓ PDF guardado: ${filename} (${(buf.length / 1024).toFixed(0)} KB)`);
      return savedAt;
    } catch (err) {
      // HttpError == se agotaron los reintentos (incluye 429 persistente).
      const reason =
        err instanceof HttpError
          ? `${err.message}${err.status ? ` [status ${err.status}]` : ''}`
          : (err as Error).message;
      logger.error(`✗ Falló la descarga de ${rec.nroResolucion || rec.uuid}: ${reason}`);
      this.storage.markFailed(rec, reason, this.config.maxRetries);
      return null;
    }
  }

  /** Descarga secuencial de una lista de registros, con delay entre PDFs. */
  async downloadMany(
    records: DocumentRecord[],
    downloadFormBase: () => Record<string, string>,
    onProgress?: (done: number, total: number, ok: boolean) => void,
  ): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    const limit = this.config.maxPdfs ?? records.length;
    const slice = records.slice(0, limit);

    for (let i = 0; i < slice.length; i++) {
      const rec = slice[i];
      const result = await this.download(rec, downloadFormBase);
      if (result) ok++;
      else failed++;
      onProgress?.(i + 1, slice.length, Boolean(result));
      if (i < slice.length - 1) await sleep(this.config.pdfDelayMs);
    }
    return { ok, failed };
  }
}
