import { BigNumber } from 'ethers';
import { LevelWithSilent, Logger, LoggerOptions, pino } from 'pino';

import { inKubernetes, safelyAccessEnvVar } from './env.js';

// Re-export Logger type for other packages to use
export type { Logger };

// Level and format here should correspond with the agent options as much as possible
// https://docs.hyperlane.xyz/docs/operate/config-reference#logfmt

// A custom enum definition because pino does not export an enum
// and because we use 'off' instead of 'silent' to match the agent options
export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
  Off = 'off',
}

let logLevel: LevelWithSilent =
  toPinoLevel(safelyAccessEnvVar('LOG_LEVEL', true)) || 'info';

function toPinoLevel(level?: string): LevelWithSilent | undefined {
  if (level && pino.levels.values[level]) return level as LevelWithSilent;
  // For backwards compat and also to match agent level options
  else if (level === 'none' || level === 'off') return 'silent';
  else return undefined;
}

export function getLogLevel() {
  return logLevel;
}

export enum LogFormat {
  Pretty = 'pretty',
  JSON = 'json',
}
let logFormat: LogFormat = LogFormat.JSON;
const envLogFormat = safelyAccessEnvVar('LOG_FORMAT', true) as
  | LogFormat
  | undefined;
if (envLogFormat && Object.values(LogFormat).includes(envLogFormat))
  logFormat = envLogFormat;

export function getLogFormat() {
  return logFormat;
}

// Note, for brevity and convenience, the rootLogger is exported directly
export let rootLogger = createHyperlanePinoLogger(logLevel, logFormat);

export function getRootLogger() {
  return rootLogger;
}

export function configureRootLogger(
  newLogFormat: LogFormat,
  newLogLevel: LogLevel,
) {
  logFormat = newLogFormat;
  logLevel = toPinoLevel(newLogLevel) || logLevel;
  rootLogger = createHyperlanePinoLogger(logLevel, logFormat);
  return rootLogger;
}

export function setRootLogger(logger: Logger) {
  rootLogger = logger;
  return rootLogger;
}

export function createHyperlanePinoLogger(
  logLevel: LevelWithSilent,
  logFormat: LogFormat,
) {
  const createFallbackLogger = () =>
    pino({
      level: logLevel,
      name: 'hyperlane',
      formatters: {
        // Remove pino's default bindings of hostname but keep pid
        bindings: (defaultBindings) => ({ pid: defaultBindings.pid }),
      },
      hooks: {
        logMethod(inputArgs, method, level) {
          // Pino has no simple way of setting custom log shapes and they
          // recommend against using pino-pretty in production so when
          // pretty is enabled we circumvent pino and log directly to console
          if (
            logFormat === LogFormat.Pretty &&
            level >= pino.levels.values[logLevel]
          ) {
            // eslint-disable-next-line no-console
            console.log(...inputArgs);
            // Then return null to prevent pino from logging
            return null;
          }
          return method.apply(this, inputArgs);
        },
      },
    });

  // In development, pino-pretty is used for a better dev experience,
  // but only if the log format is 'pretty'. This allows for JSON logs
  // in development as well if explicitly configured.
  if (
    process.env.NODE_ENV === 'development' &&
    logFormat === LogFormat.Pretty
  ) {
    try {
      return pino({
        level: logLevel,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch (err) {
      const fallbackLogger = createFallbackLogger();
      fallbackLogger.warn(
        err,
        'Could not initialize pino-pretty, falling back to built-in pretty logger',
      );
      return fallbackLogger;
    }
  }

  // In production (or other envs), use the original hook-based logger
  return createFallbackLogger();
}

export function ethersBigNumberSerializer(key: string, value: any): any {
  // Check if the value looks like a serialized BigNumber
  if (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'BigNumber' &&
    value.hex
  ) {
    return BigNumber.from(value.hex).toString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export async function tryInitializeGcpLogger(options?: {
  service?: string;
  version?: string;
}): Promise<Logger | null> {
  if (!inKubernetes()) return null;

  try {
    const { createGcpLoggingPinoConfig } = await import(
      /* webpackIgnore: true */ '@google-cloud/pino-logging-gcp-config'
    );
    const serviceContext = options
      ? {
          service: options.service ?? 'hyperlane-service',
          version: options.version ?? 'unknown',
        }
      : {};
    const gcpConfig = createGcpLoggingPinoConfig(
      { serviceContext },
      {
        base: undefined,
        name: 'hyperlane',
      },
    ) as LoggerOptions<never>;
    const gcpLogger = pino(gcpConfig);
    return gcpLogger;
  } catch (err) {
    rootLogger.warn(
      err,
      'Could not initialize GCP structured logging, ensure @google-cloud/pino-logging-gcp-config is installed',
    );
    return null;
  }
}

export async function createServiceLogger(options: {
  service: string;
  version: string;
  module?: string;
}): Promise<Logger> {
  const { service, version, module } = options;

  const gcpLogger = await tryInitializeGcpLogger({ service, version });
  if (gcpLogger) {
    // Also update rootLogger so SDK components (like SmartProvider) that use
    // rootLogger.child() will inherit the GCP logging configuration
    setRootLogger(gcpLogger);
    return gcpLogger;
  }

  // For local development, create a child logger with module info
  return rootLogger.child({ module: module ?? service });
}

export const REDACTED_URL = '<redacted-url>';
export const REDACTED_HOST = '<redacted-host>';

// ethers embeds the RPC url and the resolved hostname in provider error
// messages (e.g. `url="https://host/<api key>"`, `"hostname":"host"`), and RPC
// urls can carry credentials.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]}]+/gi;
const JSON_HOSTNAME_PATTERN = /("hostname"\s*:\s*")[^"]*"/gi;
const ASSIGNED_HOSTNAME_PATTERN = /(\bhostname=)[^\s,)}]+/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(URL_PATTERN, REDACTED_URL)
    .replace(JSON_HOSTNAME_PATTERN, `$1${REDACTED_HOST}"`)
    .replace(ASSIGNED_HOSTNAME_PATTERN, `$1${REDACTED_HOST}`);
}

export function redactErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error));
}

/**
 * Redacts the error message inside the stack. The frames, whose `file://`
 * locations match the url pattern, are kept when the stack contains the
 * message; otherwise the whole stack is redacted.
 */
export function redactErrorStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const { message, stack } = error;
  if (message === '') return stack;
  if (!stack.includes(message)) return redactSecrets(stack);
  return stack.split(message).join(redactSecrets(message));
}
