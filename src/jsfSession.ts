/**
 * Sesión JSF/PrimeFaces contra el sitio de consulta.
 *
 * Encapsula el protocolo stateful del servidor:
 *   1. GET inicial  -> cookie JSESSIONID + ViewState.
 *   2. POST AJAX "Buscar" (btnBuscar) -> primera página + rowCount.
 *   3. POST AJAX de paginación del DataTable -> página N.
 *
 * El ViewState se refresca en cada respuesta y se reutiliza en la siguiente
 * petición (requisito de JSF).
 */
import { AppConfig } from './config';
import { HttpClient, sleep } from './httpClient';
import { logger } from './logger';
import { DocumentRecord } from './types';
import {
  extractPaginationInfo,
  extractViewState,
  PaginationInfo,
  parseRows,
} from './parser';

/** Codifica un objeto plano como application/x-www-form-urlencoded. */
function form(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export class JsfSession {
  private viewState: string | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly config: AppConfig,
  ) {}

  private get formId() {
    return this.config.formId;
  }
  private get dtId() {
    return this.config.dataTableId;
  }

  /** Campos comunes del formulario presentes en todas las peticiones. */
  private baseFields(): Record<string, string> {
    return {
      [this.formId]: this.formId,
      [`${this.formId}:txtNroexp`]: '',
      [`${this.dtId}_scrollState`]: '0,0',
    };
  }

  private headersAjax(): Record<string, string> {
    return {
      'Faces-Request': 'partial/ajax',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: this.config.baseUrl,
    };
  }

  private ensureViewState(): string {
    if (!this.viewState) {
      throw new Error('ViewState no inicializado: llamá a init() primero.');
    }
    return this.viewState;
  }

  private refreshViewState(body: string): void {
    const vs = extractViewState(body);
    if (vs) this.viewState = vs;
  }

  /** 1) GET inicial: obtiene cookie de sesión y ViewState. */
  async init(): Promise<void> {
    const res = await this.http.request<string>({
      method: 'GET',
      url: this.config.baseUrl,
      responseType: 'text',
      label: 'GET página inicial',
    });
    this.refreshViewState(res.data);
    if (!this.viewState) {
      throw new Error('No se pudo extraer el ViewState del HTML inicial.');
    }
    logger.info(
      `Sesión iniciada (JSESSIONID=${this.http.hasCookie('JSESSIONID') ? 'ok' : 'no'}, ViewState=${this.viewState.length} chars).`,
    );
  }

  /**
   * 2) Ejecuta la búsqueda (botón "Buscar") y devuelve la primera página de
   * resultados junto a la info de paginación.
   */
  async search(): Promise<{ records: DocumentRecord[]; pagination: PaginationInfo }> {
    const btn = `${this.formId}:btnBuscar`;
    const payload = form({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': btn,
      'javax.faces.partial.execute': '@all',
      'javax.faces.partial.render': `${this.formId}:pgLista ${this.formId}:txtNroexp`,
      [btn]: btn,
      ...this.baseFields(),
      'javax.faces.ViewState': this.ensureViewState(),
    });

    const res = await this.http.request<string>({
      method: 'POST',
      url: this.config.baseUrl,
      data: payload,
      responseType: 'text',
      headers: this.headersAjax(),
      label: 'POST búsqueda (btnBuscar)',
    });
    this.refreshViewState(res.data);

    const pagination = extractPaginationInfo(res.data, this.config.rowsPerPage);
    if (!pagination) {
      throw new Error('No se pudo leer la info de paginación de la búsqueda.');
    }
    const records = parseRows(res.data, 1);
    logger.info(
      `Búsqueda OK: ${pagination.totalRecords} registros en ${pagination.totalPages} páginas ` +
        `(${records.length} en la página 1).`,
    );
    return { records, pagination };
  }

  /**
   * 3) Navega a una página concreta del DataTable (0-based `pageIndex`) y
   * devuelve sus filas.
   */
  async goToPage(pageIndex: number): Promise<DocumentRecord[]> {
    const first = pageIndex * this.config.rowsPerPage;
    const payload = form({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': this.dtId,
      'javax.faces.partial.execute': this.dtId,
      'javax.faces.partial.render': this.dtId,
      [this.dtId]: this.dtId,
      [`${this.dtId}_pagination`]: 'true',
      [`${this.dtId}_first`]: String(first),
      [`${this.dtId}_rows`]: String(this.config.rowsPerPage),
      [`${this.dtId}_skipChildren`]: 'true',
      [`${this.dtId}_encodeFeature`]: 'true',
      ...this.baseFields(),
      'javax.faces.ViewState': this.ensureViewState(),
    });

    const res = await this.http.request<string>({
      method: 'POST',
      url: this.config.baseUrl,
      data: payload,
      responseType: 'text',
      headers: this.headersAjax(),
      label: `POST paginación -> página ${pageIndex + 1}`,
    });
    this.refreshViewState(res.data);

    return parseRows(res.data, pageIndex + 1);
  }

  /**
   * Generador que itera por todas las páginas respetando el delay entre
   * peticiones. Cede cada lote de registros a medida que los obtiene.
   */
  async *iterateAllPages(): AsyncGenerator<{
    page: number;
    totalPages: number;
    records: DocumentRecord[];
  }> {
    await this.init();
    const { records: firstPage, pagination } = await this.search();

    const limit = this.config.maxPages
      ? Math.min(this.config.maxPages, pagination.totalPages)
      : pagination.totalPages;

    yield { page: 1, totalPages: pagination.totalPages, records: firstPage };

    for (let p = 1; p < limit; p++) {
      await sleep(this.config.requestDelayMs);
      const records = await this.goToPage(p);
      yield { page: p + 1, totalPages: pagination.totalPages, records };
    }
  }

  /** Expuesto para el descargador: el ViewState vigente. */
  get currentViewState(): string {
    return this.ensureViewState();
  }

  /** Campos base + ViewState, para construir el POST de descarga. */
  downloadFormBase(): Record<string, string> {
    return { ...this.baseFields(), 'javax.faces.ViewState': this.ensureViewState() };
  }
}
