import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { DEPLOYER } from '../../owners.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';

import { CCTP_CHAINS } from './getCCTPConfig.js';

const syntheticChain = 'bsc';

const chains = [...CCTP_CHAINS, syntheticChain] as const;

export const getRebalancingUSDCConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const registry = await getMainnet3Registry();
  const mainnetCCTP = await registry.getWarpRoute(WarpRouteIds.MainnetCCTP);
  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const metadata = await registry.getMetadata();

  const cctpBridges = Object.fromEntries(
    mainnetCCTP.tokens.map(({ chainName, addressOrDenom }) => [
      chainName,
      addressOrDenom!,
    ]),
  );

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

      const cctpBridge = cctpBridges[chain];
      const remoteDomains = chains
        .filter((c) => c !== chain)
        .map((c) => metadata[c].domainId);
      const allowedRebalancingBridges = Object.fromEntries(
        remoteDomains.map((domainId) => [domainId, [{ bridge: cctpBridge }]]),
      );

      const config: HypTokenRouterConfig = {
        owner: awIcas[chain] ?? awSafes[chain] ?? DEPLOYER,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateral,
        token: usdcTokenAddresses[chain],
        // from prerelease branch
        contractVersion: ' 8.0.0-next.0',
        allowedRebalancers: [DEPLOYER],
        allowedRebalancingBridges,
      };

      return [chain, config];
    }),
  );
};
