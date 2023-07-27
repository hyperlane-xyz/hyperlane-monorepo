import { ChainMap, Chains, CoreConfig, objMap } from '@hyperlane-xyz/sdk';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

const aggregationIsmAddresses: Record<string, string> = {
  [Chains.arbitrum]: '0x7995D00bdDb146334d6568b627bcd2a7DdA3B005',
  [Chains.avalanche]: '0xF6bF41939ebA2363A6e311E886Ed4a5ab3dc1F5D',
  [Chains.bsc]: '0x294F19d5fe29646f8E2cA4A71b6B18b78db10F9f',
  [Chains.celo]: '0x656bF500F0E2EE55F26dF3bc69b44c6eA84dd065',
  [Chains.ethereum]: '0xe39eA548F36d1c3DA9b871Badd11345f836a290A',
  [Chains.gnosis]: '0xD0Ec4de35069520CD17522281D36DD299525d85f',
  [Chains.moonbeam]: '0x04100049AC8e279C85E895d48aab1E188152e939',
  [Chains.optimism]: '0x99663d142576204284b91e96d39771db94eD5188',
  [Chains.polygon]: '0x0673cc1cc5eb80816E0d0E2dA5FE10053Da97943',
};

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = aggregationIsmAddresses[local];

  // const defaultIsm: AggregationIsmConfig = aggregationIsm(
  //   'mainnet2',
  //   local,
  //   Contexts.Hyperlane,
  // );

  if (local === 'arbitrum') {
    return {
      owner,
      defaultIsm,
      upgrade: {
        timelock: {
          // 7 days in seconds
          delay: 7 * 24 * 60 * 60,
          roles: {
            proposer: owner,
            executor: owner,
          },
        },
      },
    };
  }

  return {
    owner,
    defaultIsm,
  };
});
