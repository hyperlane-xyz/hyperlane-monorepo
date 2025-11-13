import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  OwnableConfig,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';

// Everclear-supported chains from chains.txt
export const EVERCLEAR_CHAINS = [
  'ethereum',
  'bsc',
  'optimism',
  'zksync',
  'arbitrum',
  'polygon',
  'avalanche',
  'unichain',
  'sonic',
  'mantle',
  'ink',
  'linea',
  'scroll',
  'zircuit',
  'mode',
  'base',
] as const;

export type EverclearChain = (typeof EVERCLEAR_CHAINS)[number];

// Everclear FeeAdapter addresses extracted from production deployments
const everclearAdapterAddresses: Record<EverclearChain, string> = {
  ethereum: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  bsc: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  optimism: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  zksync: '0x80EF3ee093aE3B5aDd1B213628875A4C73F640AF',
  arbitrum: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  polygon: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  avalanche: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  unichain: '0x8ad36C1aCB23b47Db6573A51a8a3009D4A4bC3b1',
  sonic: '0x6Dea30929A575B8b29F459AaE1B3b85E52a723F4',
  mantle: '0x6Dea30929A575B8b29F459AaE1B3b85E52a723F4',
  ink: '0x6Dea30929A575B8b29F459AaE1B3b85E52a723F4',
  linea: '0x1B0Dc9CB7EadDa36f4CcFB8130B0Ad967b0A3508',
  scroll: '0x1B0Dc9CB7EadDa36f4CcFB8130B0Ad967b0A3508',
  zircuit: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  mode: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  base: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
};

// USDC token addresses extracted from signatures.json asset field
const usdcTokenAddresses: Record<EverclearChain, string> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  bsc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  zksync: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  sonic: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  mantle: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
  ink: '0x2D270e6886d130D724215A266106e6832161EAEd',
  linea: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  scroll: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
  zircuit: '0x3b952c8C9C44e8Fe201e2b26F6B2200203214cfF',
  mode: '0xd988097fb8612cc24eeC14542bC03424c656005f',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

// WETH token addresses extracted from signatures.json asset field
const wethTokenAddresses: Record<EverclearChain, string> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  bsc: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  optimism: '0x4200000000000000000000000000000000000006',
  zksync: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  polygon: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  avalanche: '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
  unichain: '0x4200000000000000000000000000000000000006',
  sonic: '0x50c42dEAcD8Fc9773493ED674b675bE577f2634b',
  mantle: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111',
  ink: '0x4200000000000000000000000000000000000006',
  linea: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  scroll: '0x5300000000000000000000000000000000000004',
  zircuit: '0x4200000000000000000000000000000000000006',
  mode: '0x4200000000000000000000000000000000000006',
  base: '0x4200000000000000000000000000000000000006',
};

// USDT token addresses extracted from signatures.json asset field
const usdtTokenAddresses: Partial<Record<EverclearChain, string>> = {
  ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  bsc: '0x55d398326f99059fF775485246999027B3197955',
  optimism: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  zksync: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
  arbitrum: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  polygon: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  avalanche: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  unichain: '0x588CE4F028D8e7B53B687865d6A67b3A54C75518',
  sonic: '0x6047828dc181963ba44974801FF68e538dA5eaF9',
  mantle: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE',
  linea: '0xa219439258ca9da29e9cc4ce5596924745e12b93',
  scroll: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df',
  zircuit: '0x46dDa6a5a559d861c06EC9a95Fb395f5C3Db0742',
  mode: '0xf0F161fDA2712DB8b566946122a5af183995e2eD',
  base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
};

function getTokenAddress(chain: EverclearChain, asset: EverclearAsset): string {
  let assetAddress: string | undefined;
  switch (asset) {
    case 'USDC':
      assetAddress = usdcTokenAddresses[chain];
      break;
    case 'WETH':
      assetAddress = wethTokenAddresses[chain];
      break;
    case 'USDT':
      assetAddress = usdtTokenAddresses[chain];
      break;
  }
  if (!assetAddress) {
    throw new Error(`Token address not found for ${asset} on chain ${chain}`);
  }
  return assetAddress;
}

// Function to get owner address for a given chain
function getOwner(chain: EverclearChain): string {
  if (chain === 'ethereum') {
    return awSafes[chain];
  }
  return awIcas[chain] || awSafes[chain] || '';
}

// Chain ID to name mapping for signatures.json parsing
const CHAIN_ID_TO_NAME: Record<string, EverclearChain> = {
  '1': 'ethereum',
  '56': 'bsc',
  '10': 'optimism',
  '324': 'zksync',
  '42161': 'arbitrum',
  '137': 'polygon',
  '43114': 'avalanche',
  '130': 'unichain',
  '146': 'sonic',
  '5000': 'mantle',
  '57073': 'ink',
  '59144': 'linea',
  '534352': 'scroll',
  '48900': 'zircuit',
  '34443': 'mode',
  '8453': 'base',
};

function geScale(chain: EverclearChain): number {
  if (chain === 'bsc') {
    return 1;
  }
  return 10 ** 12;
}

function getDecimals(chain: EverclearChain): number {
  if (chain === 'bsc') {
    return 18;
  }
  return 6;
}

interface FeeData {
  sig: string;
  deadline: string;
  tokenFee: string;
  nativeFee: string;
}

type EverclearAsset = 'USDC' | 'WETH' | 'USDT';

// Function to fetch fee data from signatures.json for a given asset
function fetchFeeData(asset: EverclearAsset) {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const signaturesPath = path.join(dirname, '../../../../../signatures.json');
  const signaturesData = JSON.parse(fs.readFileSync(signaturesPath, 'utf8'));

  const result: Partial<
    Record<EverclearChain, Partial<Record<EverclearChain, FeeData>>>
  > = {};

  if (!signaturesData.signatures?.[asset]) {
    throw new Error(`No fee data found for ${asset} in signatures json`);
  }

  for (const [originChainId, destinations] of Object.entries(
    signaturesData.signatures[asset],
  )) {
    const originName = CHAIN_ID_TO_NAME[originChainId];
    if (!originName) continue; // Everclear supports this chain, but we don't want it in warp route

    const originDestinations: Partial<Record<EverclearChain, FeeData>> = {};
    result[originName] = originDestinations;

    for (const [destChainId, feeInfo] of Object.entries(
      destinations as Record<string, FeeData>,
    )) {
      const destName = CHAIN_ID_TO_NAME[destChainId];
      if (!destName) continue;

      originDestinations[destName] = feeInfo;
    }
  }

  return result;
}

const getConfigFromFeeData = (
  asset: EverclearAsset,
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): ChainMap<HypTokenRouterConfig> => {
  const feeDataByChain = fetchFeeData(asset);

  // USDT is not supported on ink chain
  let chains = [...EVERCLEAR_CHAINS];
  if (asset === 'USDT') {
    chains = chains.filter((chain) => chain !== 'ink');
  }

  return Object.fromEntries(
    chains.map((chain) => {
      const owner = getOwner(chain);
      assert(owner, `Owner not found for ${chain}`);

      // Define output assets and fee parameters per destination using real signature data
      const outputAssets = Object.fromEntries(
        chains
          .filter((c) => c !== chain)
          .map((destChain) => [
            destChain,
            addressToBytes32(getTokenAddress(destChain, asset)),
          ]),
      );

      const everclearFeeParams = Object.fromEntries(
        chains
          .filter((c) => c !== chain)
          .map((destChain) => {
            const feeData = feeDataByChain[chain]?.[destChain];
            return [
              destChain,
              {
                fee: parseInt(feeData?.tokenFee || '0'),
                deadline: parseInt(feeData?.deadline || '0'),
                signature: feeData?.sig || '',
              },
            ];
          }),
      );

      const config: HypTokenRouterConfig =
        asset === 'WETH'
          ? {
              owner,
              mailbox: routerConfig[chain].mailbox,
              type: TokenType.ethEverclear,
              wethAddress: getTokenAddress(chain, 'WETH'),
              everclearBridgeAddress: everclearAdapterAddresses[chain],
              outputAssets,
              everclearFeeParams,
            }
          : {
              owner,
              mailbox: routerConfig[chain].mailbox,
              type: TokenType.collateralEverclear,
              token: getTokenAddress(chain, asset),
              everclearBridgeAddress: everclearAdapterAddresses[chain],
              outputAssets,
              everclearFeeParams,
              scale: geScale(chain),
              decimals: getDecimals(chain),
            };
      console.log('config', chain, config);
      return [chain, config];
    }),
  ) as ChainMap<HypTokenRouterConfig>;
};

export const getEverclearUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getConfigFromFeeData('USDC', routerConfig);
};

export const getEverclearETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getConfigFromFeeData('WETH', routerConfig);
};

export const getEverclearUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getConfigFromFeeData('USDT', routerConfig);
};

// Strategy configuration following CCTP pattern
const safeChain = 'ethereum';
const icaOwner = awSafes[safeChain];
const safeSubmitter: SubmitterMetadata = {
  type: TxSubmitterType.GNOSIS_SAFE,
  chain: safeChain,
  safeAddress: icaOwner,
};

export const getEverclearStrategyConfig = (): ChainSubmissionStrategy => {
  const submitterMetadata = EVERCLEAR_CHAINS.map((chain): SubmitterMetadata => {
    if (!(chain in awIcas)) {
      return {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain,
        safeAddress: awSafes[chain],
      };
    }

    return {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: safeChain,
      owner: icaOwner,
      destinationChain: chain,
      internalSubmitter: safeSubmitter,
    };
  });

  return Object.fromEntries(
    EVERCLEAR_CHAINS.map((chain, index) => [
      chain,
      { submitter: submitterMetadata[index] },
    ]),
  );
};
