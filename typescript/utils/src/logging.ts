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
  // @ts-ignore incomplete pino constructor type
  sync: true,
  formatters: {
    bindings: () => {
      return {};
    },
  },
  // TODO avoid use of pino's pretty transport in production
  // their docs recommend against it
  transport: ENV_LOG_PRETTY
    ? {
        target: 'pino-pretty',
        options: {
          minimumLevel: ENV_LOG_LEVEL,
          colorize: false,
          sync: true,
        },
      }
    : undefined,
});
