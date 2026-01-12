export { KeyFunderConfigLoader } from './config/KeyFunderConfig.js';
export {
  KeyFunderConfigSchema,
  RoleConfigSchema,
  IgpConfigSchema,
  SweepConfigSchema,
  ChainConfigSchema,
  MetricsConfigSchema,
} from './config/types.js';
export type {
  KeyFunderConfig,
  KeyFunderConfigInput,
  RoleConfig,
  IgpConfig,
  SweepConfig,
  ChainConfig,
  MetricsConfig,
  ResolvedKeyConfig,
} from './config/types.js';

export {
  KeyFunder,
  calculateMultipliedBalance,
  type KeyFunderOptions,
} from './core/KeyFunder.js';
export { KeyFunderMetrics } from './metrics/Metrics.js';
