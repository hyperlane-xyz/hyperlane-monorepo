import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getChainAddresses } from '../../../../registry.js';
// import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
// import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
// import { usdcTokenAddresses } from '../cctp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
// import { WarpRouteIds } from '../warpIds.js';

import {
  getFileSubmitterStrategyConfig,
  // getFixedRoutingFeeConfig,
  // getRebalancingUSDCConfigForChain,
  // getUSDCRebalancingBridgesConfigFor,
} from './utils.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

const contractVersion = '11.0.3';

const usdtTokenAddresses: Record<string, string> = {
  ethereum: tokens.ethereum.USDT,
  // TODO: Add more chains as they are enrolled
  // arbitrum: tokens.arbitrum.USDT,
  // base: tokens.base.USDT,
  // optimism: tokens.optimism.USDT,
  // polygon: tokens.polygon.USDT,
  solanamainnet: tokens.solanamainnet.USDT,
};

const awProxyAdminAddresses: ChainMap<string> = {
  ethereum: '0x692e50577fAaBF10F824Dc8Ce581e3Af93785175',
};

const awProxyAdminOwners: ChainMap<string | undefined> = {
  ethereum: awSafes.ethereum,
} as const;

export const evmDeploymentChains = ['ethereum'];

export const nonEvmDeploymentChains = ['eclipsemainnet', 'solanamainnet'];

const deploymentChains = [
  ...evmDeploymentChains,
  ...nonEvmDeploymentChains,
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

// TODO: Uncomment when adding rebalancing support
// EVM chains with CCTP rebalancing support
// export const rebalanceableCollateralChains = [
//   'ethereum',
// ] as const satisfies DeploymentChain[];

// TODO: Uncomment when adding fee support
// On-chain LinearFee parameters for already-deployed chains.
// const deployedChainFeeParams: Record<
//   string,
//   { maxFee: string; halfAmount: string }
// > = {
//   ethereum: {
//     maxFee: 'TODO',
//     halfAmount: 'TODO',
//   },
// };

const productionOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  eclipsemainnet: chainOwners.eclipsemainnet.owner,
  solanamainnet: chainOwners.solanamainnet.owner,
};

const PRODUCTION_PROGRAM_IDS = {
  eclipsemainnet: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
  solanamainnet: 'Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU', // Not yet enrolled
};

export interface EclipseUSDTWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  programIds: {
    eclipsemainnet: string;
    solanamainnet: string;
  };
  tokenMetadata?: { symbol: string; name: string };
  proxyAdmins: ChainMap<{ address: string; owner: string }>;
}

export const buildEclipseUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: EclipseUSDTWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ownersByChain, programIds, tokenMetadata, proxyAdmins } = options;

  // TODO: Uncomment when adding rebalancing support
  // const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  //   rebalanceableCollateralChains,
  //   [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  // );

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // Configure EVM collateral chains
  // TODO: Uncomment when adding rebalancing support
  // const rebalanceableSet = new Set<string>(rebalanceableCollateralChains);

  for (const chain of evmDeploymentChains) {
    const proxyAdmin = proxyAdmins[chain];
    assert(proxyAdmin, `Missing proxyAdmin for chain ${chain}`);

    // TODO: Replace this block with rebalancing logic when ready:
    // if (rebalanceableSet.has(chain)) {
    //   const baseConfig = getRebalancingUSDCConfigForChain(
    //     chain as (typeof rebalanceableCollateralChains)[number],
    //     routerConfig,
    //     ownersByChain,
    //     rebalancingConfigByChain,
    //   );
    //   const destinations = rebalanceableCollateralChains.filter(
    //     (c) => c !== chain,
    //   );
    //   const originFeeParams = deployedChainFeeParams[chain];
    //   const feeParams = originFeeParams
    //     ? Object.fromEntries(destinations.map((d) => [d, originFeeParams]))
    //     : undefined;
    //   chainConfig = {
    //     ...baseConfig,
    //     ...tokenMetadata,
    //     proxyAdmin,
    //     tokenFee: getFixedRoutingFeeConfig(
    //       getWarpFeeOwner(chain),
    //       destinations,
    //       5n,
    //       feeParams,
    //     ),
    //   };
    // } else {
    //   ... (current collateral config below)
    // }

    const usdtToken = usdtTokenAddresses[chain];
    assert(usdtToken, `USDT address not defined for ${chain}`);

    configs.push([
      chain,
      {
        ...tokenMetadata,
        type: TokenType.collateral,
        token: usdtToken,
        owner: ownersByChain[chain],
        proxyAdmin,
        mailbox: routerConfig[chain].mailbox,
        contractVersion,
      },
    ]);
  }

  // Configure non-evm chains
  configs.push([
    'eclipsemainnet',
    {
      type: TokenType.synthetic,
      mailbox: routerConfig.eclipsemainnet.mailbox,
      foreignDeployment: programIds.eclipsemainnet,
      owner: ownersByChain.eclipsemainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  // TODO: Uncomment when enrolling Solana (add solanamainnet to usdtTokenAddresses first)
  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: usdtTokenAddresses.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: programIds.solanamainnet,
      owner: ownersByChain.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
  ]);

  return Object.fromEntries(configs);
};

const awProxyAdmins: ChainMap<{ address: string; owner: string }> =
  Object.fromEntries(
    Object.entries(awProxyAdminAddresses).map(([chain, address]) => [
      chain,
      {
        address,
        owner: awProxyAdminOwners[chain] ?? chainOwners[chain].owner,
      },
    ]),
  );

export const getEclipseUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildEclipseUSDTWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    programIds: PRODUCTION_PROGRAM_IDS,
    proxyAdmins: awProxyAdmins,
  });

// Strategies
export const getEclipseUSDTGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(
    objFilter(
      productionOwnersByChain,
      (chain, _v): _v is string =>
        chain !== 'solanamainnet' && chain !== 'eclipsemainnet',
    ),
  );

const ORIGIN_CHAIN = 'ethereum';

export const getEclipseUSDTStrategyConfig = (): ChainSubmissionStrategy => {
  const safeAddress = awSafes[ORIGIN_CHAIN];
  const originSafeSubmitter = {
    type: TxSubmitterType.GNOSIS_SAFE as const,
    chain: ORIGIN_CHAIN,
    safeAddress,
  };

  const chainAddress = getChainAddresses();
  const originInterchainAccountRouter =
    chainAddress[ORIGIN_CHAIN].interchainAccountRouter;
  assert(
    originInterchainAccountRouter,
    `Could not fetch originInterchainAccountRouter for ${ORIGIN_CHAIN}`,
  );

  const icaChains = evmDeploymentChains.filter((c) => c !== ORIGIN_CHAIN);
  const icaStrategies: [string, SubmissionStrategy][] = icaChains.map(
    (chain) => [
      chain,
      {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
          chain: ORIGIN_CHAIN,
          destinationChain: chain,
          owner: safeAddress,
          originInterchainAccountRouter,
          internalSubmitter: originSafeSubmitter,
        },
      },
    ],
  );

  return Object.fromEntries([
    [ORIGIN_CHAIN, { submitter: originSafeSubmitter }],
    ...icaStrategies,
  ]);
};
