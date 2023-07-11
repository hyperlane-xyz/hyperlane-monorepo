import {
  CctpAdapter__factory,
  ProxyAdmin__factory,
} from '../../../../../solidity/dist';

export const liquidityLayerV2Factories = {
  proxyAdmin: new ProxyAdmin__factory(),
  CctpAdapter: new CctpAdapter__factory(),
};

export type LiquidityLayerV2Factories = typeof liquidityLayerV2Factories;
