import { LevelWithSilent, pino } from 'pino';

import { envVarToBoolean, safelyAccessEnvVar } from './env';

const DEFAULT_LOG_LEVEL = 'warn';

let ENV_LOG_LEVEL = (
  safelyAccessEnvVar('LOG_LEVEL') ?? DEFAULT_LOG_LEVEL
).toLowerCase() as LevelWithSilent | 'none' | 'off';
// For backwards compat and also to match agent level options
if (ENV_LOG_LEVEL === 'none' || ENV_LOG_LEVEL === 'off')
  ENV_LOG_LEVEL = 'silent';

const ENV_LOG_PRETTY = envVarToBoolean(safelyAccessEnvVar('LOG_PRETTY'));

export const rootLogger = pino({
  level: ENV_LOG_LEVEL,
  name: 'hyperlane',
  formatters: {
    // Remove pino's default bindings of hostname and pid
    bindings: () => ({}),
  },
  hooks: {
    logMethod(inputArgs, method, level) {
      // Pino has no simply way of setting custom log shapes and they
      // recommend against using pino-pretty in production so when
      // pretty is enabled we circumvent pino and log directly to console
      if (ENV_LOG_PRETTY && level >= pino.levels.values[ENV_LOG_LEVEL]) {
        // eslint-disable-next-line no-console
        console.log(inputArgs[0]);
        return null;
      }
      return method.apply(this, inputArgs);
    },
  },
});
