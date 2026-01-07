export { KeyFunderConfigLoader } from './config/KeyFunderConfig.js';
export {
  KeyFunderConfigSchema,
  RoleConfigSchema,
  IgpConfigSchema,
  SweepConfigSchema,
  ChainConfigSchema,
  FunderConfigSchema,
  MetricsConfigSchema,
} from './config/types.js';
export type {
  KeyFunderConfig,
  KeyFunderConfigInput,
  RoleConfig,
  IgpConfig,
  SweepConfig,
  ChainConfig,
  FunderConfig,
  MetricsConfig,
  ResolvedKeyConfig,
} from './config/types.js';

export { KeyFunder, type KeyFunderOptions } from './core/KeyFunder.js';
export { KeyFunderMetrics } from './metrics/Metrics.js';
