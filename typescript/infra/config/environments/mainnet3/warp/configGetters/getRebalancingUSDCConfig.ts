import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { DEPLOYER } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';

import { CCTP_CHAINS } from './getCCTPConfig.js';

const syntheticChain = 'bsc';

const chains = [...CCTP_CHAINS, syntheticChain] as const;

export const getRebalancingUSDCConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    chains.map((chain) => {
      const owner = awIcas[chain] ?? awSafes[chain];
      const mailbox = routerConfig[chain].mailbox;

      if (chain === syntheticChain) {
        return [
          chain,
          {
            owner,
            mailbox,
            type: TokenType.synthetic,
          },
        ];
      }

      const config: HypTokenRouterConfig = {
        owner: awIcas[chain] ?? awSafes[chain] ?? DEPLOYER,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateral,
        token: usdcTokenAddresses[chain],
        // from prerelease branch
        contractVersion: ' 8.0.0-next.0',
      };

      return [chain, config];
    }),
  );
};
