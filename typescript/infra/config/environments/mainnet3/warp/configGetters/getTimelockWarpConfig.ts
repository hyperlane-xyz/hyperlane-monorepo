import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcasV2 } from '../../governance/ica/aw2.js';
import { awSafes } from '../../governance/safe/aw.js';
import { awTimelocks } from '../../governance/timelock/aw.js';

import {
  oUSDTDeploymentChains,
  oUSDTTokenChainName,
} from './getoUSDTTokenWarpConfig.js';

const ownerChain: oUSDTTokenChainName = 'ethereum';
export const nativeTokenChain: oUSDTTokenChainName = 'base';

export const getTimelockTestWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    oUSDTDeploymentChains.map(
      (currentChain): [oUSDTTokenChainName, HypTokenRouterConfig] => {
        const owner = awTimelocks[currentChain];
        assert(owner, `Expected owner on chain ${currentChain} to be defined`);

        if (currentChain === nativeTokenChain) {
          return [
            currentChain,
            {
              type: TokenType.native,
              mailbox: routerConfig[currentChain].mailbox,
              owner,
            },
          ];
        }

        return [
          currentChain,
          {
            type: TokenType.synthetic,
            mailbox: routerConfig[currentChain].mailbox,
            owner,
          },
        ];
      },
    ),
  );
};

// used yarn tsx scripts/check/check-owner-ica.ts -e mainnet3 --ownerChain ethereum --governanceType abacusWorks
// to verify that v2 icas are owned by aw on eth
export const getOUSDTSubmitterStrategy = (): ChainSubmissionStrategy => {
  return Object.fromEntries(
    oUSDTDeploymentChains.map(
      (chainName): [oUSDTTokenChainName, SubmissionStrategy] => {
        if (chainName === ownerChain) {
          return [
            ownerChain,
            {
              submitter: {
                type: TxSubmitterType.TIMELOCK_CONTROLLER,
                chain: ownerChain,
                timelockAddress: awTimelocks[ownerChain],
                proposerSubmitter: {
                  type: TxSubmitterType.GNOSIS_TX_BUILDER,
                  chain: ownerChain,
                  safeAddress: awSafes[ownerChain],
                  version: '1.0',
                },
              },
            },
          ];
        }

        return [
          chainName,
          {
            submitter: {
              type: TxSubmitterType.TIMELOCK_CONTROLLER,
              chain: chainName,
              timelockAddress: awTimelocks[chainName],
              proposerSubmitter: {
                type: TxSubmitterType.INTERCHAIN_ACCOUNT,
                chain: ownerChain,
                destinationChain: chainName,
                owner: awSafes[chainName],
                // Timelocks have as proposer the v2 ICAs
                originInterchainAccountRouter: awIcasV2[ownerChain],
                internalSubmitter: {
                  type: TxSubmitterType.GNOSIS_TX_BUILDER,
                  chain: ownerChain,
                  safeAddress: awSafes[ownerChain],
                  version: '1.0',
                },
              },
            },
          },
        ];
      },
    ),
  );
};
