/**
 * Punto de entrada / CLI del scraper.
 *
 * Uso:
 *   npm run scrape                       # todo: metadatos + PDFs
 *   npm run scrape -- --no-pdf           # solo metadatos
 *   npm run scrape -- --max-pages 2 --max-pdfs 3
 *   npm run retry                        # reintenta descargas fallidas
 *
 * Flags:
 *   --no-pdf            No descarga PDFs (solo extrae metadatos).
 *   --max-pages N       Límite de páginas a recorrer.
 *   --max-pdfs N        Límite de PDFs a descargar.
 *   --retry-failed      Reintenta las descargas del registro de fallidas.
 *   --delay MS          Delay base entre requests (ms).
 *   --url URL           Sobreescribe la URL objetivo.
 *   --help              Muestra esta ayuda.
 */
import { AppConfig, DEFAULT_CONFIG } from './config';
import { logger } from './logger';
import { Scraper } from './scraper';

function parseArgs(argv: string[]): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CONFIG };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--no-pdf':
        cfg.downloadPdfs = false;
        break;
      case '--retry-failed':
        cfg.retryFailed = true;
        break;
      case '--max-pages':
        cfg.maxPages = Number(next());
        break;
      case '--max-pdfs':
        cfg.maxPdfs = Number(next());
        break;
      case '--delay':
        cfg.requestDelayMs = Number(next());
        break;
      case '--url':
        cfg.baseUrl = next();
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        logger.warn(`Flag desconocido ignorado: ${a}`);
    }
  }
  return cfg;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
Scraper OEFA / Jurisprudencia PJ — TypeScript (sin navegador)

Uso:
  npm run scrape                         Extrae metadatos y descarga PDFs
  npm run scrape -- --no-pdf             Solo metadatos
  npm run scrape -- --max-pages 2 --max-pdfs 3   Prueba acotada
  npm run retry                          Reintenta descargas fallidas

Flags:
  --no-pdf          No descarga PDFs
  --max-pages N     Límite de páginas
  --max-pdfs N      Límite de PDFs
  --retry-failed    Reintenta el registro de descargas fallidas
  --delay MS        Delay base entre requests (ms)
  --url URL         URL objetivo (por defecto: OEFA)
  --help            Esta ayuda
`);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  logger.info(`Objetivo: ${config.baseUrl}`);
  logger.info(
    `Modo: ${config.retryFailed ? 'reintento de fallidas' : config.downloadPdfs ? 'metadatos + PDFs' : 'solo metadatos'}` +
      `${config.maxPages ? ` | max-pages=${config.maxPages}` : ''}` +
      `${config.maxPdfs !== undefined ? ` | max-pdfs=${config.maxPdfs}` : ''}`,
  );

  const scraper = new Scraper(config);
  try {
    await scraper.run();
  } catch (err) {
    logger.error(`Error fatal: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// Cierre ordenado ante Ctrl+C (los datos ya se persisten de forma incremental).
process.on('SIGINT', () => {
  logger.warn('Interrumpido por el usuario (SIGINT). El progreso quedó guardado.');
  process.exit(130);
});

void main();
