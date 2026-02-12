import { getEclipseUSDCTransferRouterConfig } from './environments/mainnet3/warp/configGetters/getEclipseUSDCTransferRouterConfig.js';
import { TransferRouterIds } from './environments/mainnet3/warp/transferRouterIds.js';

type TransferRouterConfigGetter = () => Record<
  string,
  { token: string; owner: string; fee?: unknown }
>;

export const transferRouterConfigGetterMap: Record<
  string,
  TransferRouterConfigGetter
> = {
  [TransferRouterIds.EclipseUSDC]: getEclipseUSDCTransferRouterConfig,
};
