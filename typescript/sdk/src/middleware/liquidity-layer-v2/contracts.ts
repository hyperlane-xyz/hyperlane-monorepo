import {
  CCTPAdapter__factory,
  ProxyAdmin__factory,
} from '../../../../../solidity/dist';

export const liquidityLayerV2Factories = {
  proxyAdmin: new ProxyAdmin__factory(),
  CCTPAdapter: new CCTPAdapter__factory(),
};

export type LiquidityLayerV2Factories = typeof liquidityLayerV2Factories;
