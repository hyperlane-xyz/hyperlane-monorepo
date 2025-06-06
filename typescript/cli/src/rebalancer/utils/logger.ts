import { rootLogger } from '@hyperlane-xyz/utils';

export const monitorLogger = rootLogger.child({ module: 'rebalancer-monitor' });
export const rebalancerLogger = rootLogger.child({
  module: 'rebalancer',
});
export const strategyLogger = rootLogger.child({
  module: 'rebalancer-strategy',
});
