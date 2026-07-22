/**
 * Persistencia de resultados: metadatos (JSON + CSV) y registro de descargas
 * fallidas (JSON) para poder reintentarlas después.
 *
 * La escritura es incremental: tras cada página se vuelca el estado a disco,
 * de modo que una interrupción no pierde el progreso.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from './config';
import { DocumentRecord, FailedDownload } from './types';
import { logger } from './logger';

export class Storage {
  private records: DocumentRecord[] = [];
  private failed = new Map<string, FailedDownload>();

  constructor(private readonly config: AppConfig) {
    this.ensureDirs();
    this.loadFailed();
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    fs.mkdirSync(this.config.pdfDir, { recursive: true });
  }

  // ---------- Metadatos ----------

  addRecords(recs: DocumentRecord[]): void {
    this.records.push(...recs);
  }

  get allRecords(): DocumentRecord[] {
    return this.records;
  }

  /** Vuelca los metadatos acumulados a JSON y CSV. */
  flushData(): void {
    fs.writeFileSync(this.config.dataJsonPath, JSON.stringify(this.records, null, 2), 'utf-8');
    fs.writeFileSync(this.config.dataCsvPath, this.toCsv(this.records), 'utf-8');
  }

  private toCsv(recs: DocumentRecord[]): string {
    const headers = [
      'nro',
      'numeroExpediente',
      'administrado',
      'unidadFiscalizable',
      'sector',
      'nroResolucion',
      'uuid',
      'page',
    ];
    const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const r of recs) {
      lines.push(
        [
          r.nro,
          r.numeroExpediente,
          r.administrado,
          r.unidadFiscalizable,
          r.sector,
          r.nroResolucion,
          r.uuid,
          String(r.page),
        ]
          .map(esc)
          .join(','),
      );
    }
    // BOM para que Excel abra los acentos correctamente.
    return '﻿' + lines.join('\r\n');
  }

  // ---------- Registro de fallidas ----------

  private loadFailed(): void {
    if (!fs.existsSync(this.config.failedPath)) return;
    try {
      const arr: FailedDownload[] = JSON.parse(
        fs.readFileSync(this.config.failedPath, 'utf-8'),
      );
      for (const f of arr) this.failed.set(f.uuid, f);
      if (arr.length) logger.info(`Cargadas ${arr.length} descargas fallidas previas.`);
    } catch (e) {
      logger.warn(`No se pudo leer ${this.config.failedPath}: ${(e as Error).message}`);
    }
  }

  markFailed(rec: DocumentRecord, reason: string, attempts: number): void {
    this.failed.set(rec.uuid, {
      uuid: rec.uuid,
      nroResolucion: rec.nroResolucion,
      numeroExpediente: rec.numeroExpediente,
      rowIndex: rec.rowIndex,
      downloadSourceId: rec.downloadSourceId,
      page: rec.page,
      reason,
      attempts,
      lastTriedAt: new Date().toISOString(),
    });
    this.flushFailed();
  }

  /** Quita un uuid del registro de fallidas (descarga finalmente exitosa). */
  clearFailed(uuid: string): void {
    if (this.failed.delete(uuid)) this.flushFailed();
  }

  get failedList(): FailedDownload[] {
    return Array.from(this.failed.values());
  }

  private flushFailed(): void {
    fs.writeFileSync(this.config.failedPath, JSON.stringify(this.failedList, null, 2), 'utf-8');
  }

  // ---------- PDFs ----------

  /** ¿Ya existe un PDF (no vacío) con ese nombre? Permite reanudar. */
  pdfExists(filename: string): boolean {
    const p = path.join(this.config.pdfDir, filename);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  }

  savePdf(filename: string, data: Buffer): string {
    const p = path.join(this.config.pdfDir, filename);
    fs.writeFileSync(p, data);
    return p;
  }
}
