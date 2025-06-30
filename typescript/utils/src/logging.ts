import { BigNumber } from 'ethers';
import { LevelWithSilent, Logger, LoggerOptions, pino } from 'pino';

import { safelyAccessEnvVar } from './env.js';

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
  return pino({
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
  return value;
}

export async function tryInitializeGcpLogger(options?: {
  service?: string;
  version?: string;
}): Promise<Logger | null> {
  const isKubernetes = process.env.KUBERNETES_SERVICE_HOST !== undefined;
  if (!isKubernetes) return null;

  try {
    const { createGcpLoggingPinoConfig } = await import(
      '@google-cloud/pino-logging-gcp-config'
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
    return gcpLogger;
  }

  // For local development, create a child logger with module info
  return rootLogger.child({ module: module ?? service });
}
