import chalk, { ChalkInstance } from 'chalk';
import { pino } from 'pino';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  getLogFormat,
  rootLogger,
  safelyAccessEnvVar,
} from '@hyperlane-xyz/utils';

let logger = rootLogger;

export function configureLogger(logFormat: LogFormat, logLevel: LogLevel) {
  logFormat =
    logFormat || safelyAccessEnvVar('LOG_FORMAT', true) || LogFormat.Pretty;
  logLevel = logLevel || safelyAccessEnvVar('LOG_LEVEL', true) || LogLevel.Info;
  logger = configureRootLogger(logFormat, logLevel).child({ module: 'cli' });
}

export const log = (msg: string, ...args: any) => logger.info(msg, ...args);

export function logColor(
  level: pino.Level,
  chalkInstance: ChalkInstance,
  ...args: any
) {
  // Only use color when pretty is enabled
  if (getLogFormat() === LogFormat.Pretty) {
    logger[level](chalkInstance(...args));
  } else {
    // @ts-ignore pino type more restrictive than pino's actual arg handling
    logger[level](...args);
  }
}
export const logBlue = (...args: any) => logColor('info', chalk.blue, ...args);
export const logPink = (...args: any) =>
  logColor('info', chalk.magentaBright, ...args);
export const logGray = (...args: any) => logColor('info', chalk.gray, ...args);
export const logGreen = (...args: any) =>
  logColor('info', chalk.green, ...args);
export const logRed = (...args: any) => logColor('info', chalk.red, ...args);
export const logBoldUnderlinedRed = (...args: any) =>
  logColor('info', chalk.red.bold.underline, ...args);
export const logTip = (...args: any) =>
  logColor('info', chalk.bgYellow, ...args);
export const warnYellow = (...args: any) =>
  logColor('warn', chalk.yellow, ...args);
export const errorRed = (...args: any) => logColor('error', chalk.red, ...args);

// No support for table in pino so print directly to console
export const logTable = (...args: any) => console.table(...args);
