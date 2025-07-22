import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

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

// copied from https://github.com/hyperlane-xyz/hyperlane-registry/pull/946/files
const icaRoutersV2ByChain: Record<oUSDTTokenChainName, Address> = {
  base: '0x44647Cd983E80558793780f9a0c7C2aa9F384D07',
  bitlayer: '0xE0208ddBe76c703eb3Cd758a76e2c8c1Ff9472fD',
  bob: '0xA6f0A37DFDe9C2c8F46F010989C47d9edB3a9FA8',
  botanix: '0x21b5a2fA1f53e94cF4871201aeD30C6ad5E405f2',
  celo: '0x1eA7aC243c398671194B7e2C51d76d1a1D312953',
  ethereum: '0xC00b94c115742f711a6F9EA90373c33e9B72A4A9',
  fraxtal: '0xD59a200cCEc5b3b1bF544dD7439De452D718f594',
  hashkey: '0xD79A14EA21db52F130A57Ea6e2af55949B00086E',
  ink: '0x55Ba00F1Bac2a47e0A73584d7c900087642F9aE3',
  linea: '0xBfC8DCEf3eFabC064f5afff4Ac875a82D2Dc9E55',
  lisk: '0xE59592a179c4f436d5d2e4caA6e2750beA4E3166',
  mantle: '0x31e81982E98F5D321F839E82789b628AedB15751',
  metal: '0x0b2d429acccAA411b867d57703F88Ed208eC35E4',
  metis: '0x04Bd82Ba84a165BE5D555549ebB9890Bb327336E',
  mode: '0x860ec58b115930EcbC53EDb8585C1B16AFFF3c50',
  optimism: '0x3E343D07D024E657ECF1f8Ae8bb7a12f08652E75',
  ronin: '0xd6b12ecC223b483427ea66B029b4EEfcC1af86DC',
  soneium: '0xc08C1451979e9958458dA3387E92c9Feb1571f9C',
  sonic: '0xEfad3f079048bE2765b6bCfAa3E9d99e9A2C3Df6',
  superseed: '0x3CA0e8AEfC14F962B13B40c6c4b9CEE3e4927Ae3',
  swell: '0x95Fb6Ca1BBF441386b119ad097edcAca3b1C35B7',
  unichain: '0x43320f6B410322Bf5ca326a0DeAaa6a2FC5A021B',
  worldchain: '0xd55bFDfb3486fE49a0b2E2Af324453452329051F',
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
                owner: awSafes[ownerChain],
                // Timelocks have as proposer the v2 ICAs
                originInterchainAccountRouter: icaRoutersV2ByChain[ownerChain],
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
