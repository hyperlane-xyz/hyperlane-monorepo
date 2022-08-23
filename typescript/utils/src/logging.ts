import { safelyAccessEnvVar } from './utils';

/* eslint-disable no-console */
type LOG_LEVEL = 'none' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ENV_LOG_LEVEL = (
  safelyAccessEnvVar('LOG_LEVEL') ?? 'debug'
).toLowerCase() as LOG_LEVEL;
const LOG_TRACE = ENV_LOG_LEVEL == 'trace';
const LOG_DEBUG = LOG_TRACE || ENV_LOG_LEVEL == 'debug';
const LOG_INFO = LOG_DEBUG || ENV_LOG_LEVEL == 'info';
const LOG_WARN = LOG_INFO || ENV_LOG_LEVEL == 'warn';
const LOG_ERROR = LOG_WARN || ENV_LOG_LEVEL == 'error';

export function trace(message: string, data?: any) {
  if (LOG_TRACE) logWithFunction(console.trace, 'trace', message, data);
}

export function debug(message: string, data?: any) {
  if (LOG_DEBUG) logWithFunction(console.debug, 'debug', message, data);
}

export function log(message: string, data?: any) {
  if (LOG_INFO) logWithFunction(console.log, 'info', message, data);
}

export function warn(message: string, data?: any) {
  if (LOG_WARN) logWithFunction(console.warn, 'warn', message, data);
}

export function error(message: string, data?: any) {
  if (LOG_ERROR) logWithFunction(console.error, 'error', message, data);
}

function logWithFunction(
  logFn: (...contents: any[]) => void,
  level: LOG_LEVEL,
  message: string,
  data?: any,
) {
  const fullLog = {
    ...data,
    level,
    message,
  };
  logFn(JSON.stringify(fullLog));
}
