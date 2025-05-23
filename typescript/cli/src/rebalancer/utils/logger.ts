import { rootLogger } from '@hyperlane-xyz/utils';

// TODO: this is to keep the same logging structure as in the monitor, but we may need change the module name
export const logger = rootLogger.child({ module: 'warp-balance-monitor' });
