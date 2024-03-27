import { LevelWithSilent, pino } from 'pino';

import { envVarToBoolean, safelyAccessEnvVar } from './env';

let logLevel: LevelWithSilent = 'info';
const envLogLevel = safelyAccessEnvVar('LOG_LEVEL')?.toLowerCase();
if (envLogLevel && pino.levels.values[envLogLevel]) {
  logLevel = envLogLevel as LevelWithSilent;
}
// For backwards compat and also to match agent level options
else if (envLogLevel === 'none' || envLogLevel === 'off') {
  logLevel = 'silent';
}

export const isLogPretty = envVarToBoolean(safelyAccessEnvVar('LOG_PRETTY'));

export const rootLogger = pino({
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
      if (isLogPretty && level >= pino.levels.values[logLevel]) {
        // eslint-disable-next-line no-console
        console.log(...inputArgs);
        // Then return null to prevent pino from logging
        return null;
      }
      return method.apply(this, inputArgs);
    },
  },
});
