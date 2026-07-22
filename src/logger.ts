/**
 * Logger minimalista con niveles y timestamp.
 *
 * Se evita añadir dependencias externas: el reto pide solo axios + cheerio.
 */

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const COLORS: Record<Level, string> = {
  DEBUG: '\x1b[90m', // gris
  INFO: '\x1b[36m', // cian
  WARN: '\x1b[33m', // amarillo
  ERROR: '\x1b[31m', // rojo
};
const RESET = '\x1b[0m';

const LEVEL_ORDER: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** Nivel mínimo a mostrar. Configurable vía env var LOG_LEVEL. */
const minLevel: Level = (process.env.LOG_LEVEL as Level) || 'INFO';

function log(level: Level, msg: string, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const color = COLORS[level];
  // eslint-disable-next-line no-console
  console.log(`${color}[${ts}] [${level}]${RESET} ${msg}`, ...args);
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log('DEBUG', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log('INFO', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('WARN', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('ERROR', msg, ...args),
};
