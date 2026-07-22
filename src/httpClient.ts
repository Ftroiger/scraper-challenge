/**
 * Cliente HTTP con:
 *   - Cookie jar propio (JSF/PrimeFaces exige mantener JSESSIONID).
 *   - Reintentos con backoff exponencial + jitter para errores 429 y
 *     transitorios (5xx, ECONNRESET, timeouts).
 *   - Respeto de la cabecera `Retry-After` cuando el servidor la envía.
 *
 * No se usa ninguna librería de cookies externa para mantener el set de
 * dependencias en axios + cheerio, tal como pide el reto.
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { AppConfig } from './config';
import { logger } from './logger';

/** Duerme `ms` milisegundos. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Almacén de cookies muy simple (name -> value). Suficiente para un único
 * host/path como el del reto. Ignora atributos (Path/Secure/HttpOnly...).
 */
class CookieJar {
  private jar = new Map<string, string>();

  /** Procesa las cabeceras Set-Cookie de una respuesta. */
  update(setCookie?: string[] | string): void {
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of cookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  /** Devuelve el header `Cookie` a enviar, o undefined si está vacío. */
  header(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

/** Error tipado que sobrevive al agotamiento de reintentos. */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly jar = new CookieJar();

  constructor(private readonly config: AppConfig) {
    this.axios = axios.create({
      timeout: config.timeoutMs,
      // Nunca lanzamos por status: gestionamos 429/5xx nosotros mismos.
      validateStatus: () => true,
      maxRedirects: 5,
      headers: {
        'User-Agent': config.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
      },
    });
  }

  hasCookie(name: string): boolean {
    return this.jar.has(name);
  }

  /**
   * Realiza una petición con reintentos. Devuelve la respuesta de axios en
   * cuanto obtiene un status "final" (2xx/3xx/4xx que no sea 429).
   * Lanza HttpError si se agotan los reintentos o ante 4xx no recuperables.
   */
  async request<T = unknown>(
    cfg: AxiosRequestConfig & { label?: string },
  ): Promise<AxiosResponse<T>> {
    const label = cfg.label ?? `${cfg.method ?? 'GET'} ${cfg.url ?? this.config.baseUrl}`;
    let attempt = 0;

    // Total de intentos = 1 (inicial) + maxRetries.
    while (true) {
      attempt++;
      try {
        const headers = { ...(cfg.headers ?? {}) } as Record<string, string>;
        const cookie = this.jar.header();
        if (cookie) headers['Cookie'] = cookie;

        const res = await this.axios.request<T>({ ...cfg, headers });
        this.jar.update(res.headers['set-cookie']);

        // 429 -> backoff y reintento.
        if (res.status === 429) {
          if (attempt > this.config.maxRetries) {
            throw new HttpError(`429 tras ${attempt - 1} reintentos: ${label}`, 429);
          }
          const wait = this.computeBackoff(attempt, res.headers['retry-after']);
          logger.warn(
            `429 Too Many Requests en "${label}". Reintento ${attempt}/${this.config.maxRetries} en ${wait} ms.`,
          );
          await sleep(wait);
          continue;
        }

        // 5xx -> transitorio, reintenta.
        if (res.status >= 500 && res.status <= 599) {
          if (attempt > this.config.maxRetries) {
            throw new HttpError(`HTTP ${res.status} tras reintentos: ${label}`, res.status);
          }
          const wait = this.computeBackoff(attempt);
          logger.warn(
            `HTTP ${res.status} en "${label}". Reintento ${attempt}/${this.config.maxRetries} en ${wait} ms.`,
          );
          await sleep(wait);
          continue;
        }

        // Otros 4xx: no recuperables con reintento.
        if (res.status >= 400) {
          throw new HttpError(`HTTP ${res.status} en ${label}`, res.status);
        }

        return res;
      } catch (err) {
        if (err instanceof HttpError) throw err;

        // Errores de red/timeout: transitorios -> reintenta con backoff.
        const isTransient = axios.isAxiosError(err);
        if (!isTransient || attempt > this.config.maxRetries) {
          throw new HttpError(`Fallo de red en ${label}: ${(err as Error).message}`, undefined, err);
        }
        const wait = this.computeBackoff(attempt);
        logger.warn(
          `Error de red en "${label}" (${(err as Error).message}). Reintento ${attempt}/${this.config.maxRetries} en ${wait} ms.`,
        );
        await sleep(wait);
      }
    }
  }

  /**
   * Backoff exponencial con jitter. Si el servidor manda `Retry-After`
   * (segundos), se respeta como piso mínimo de espera.
   */
  private computeBackoff(attempt: number, retryAfter?: string): number {
    let base = Math.min(
      this.config.backoffBaseMs * 2 ** (attempt - 1),
      this.config.backoffMaxMs,
    );
    // Jitter "full": aleatoriza entre 0 y base para evitar sincronización.
    let wait = Math.random() * base;

    if (retryAfter) {
      const secs = Number(retryAfter);
      if (!Number.isNaN(secs)) wait = Math.max(wait, secs * 1000);
    }
    return Math.round(Math.max(wait, this.config.backoffBaseMs));
  }
}
