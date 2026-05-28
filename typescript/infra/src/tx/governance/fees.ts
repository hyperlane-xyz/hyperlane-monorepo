import {
  BaseFee__factory,
  RoutingFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  DerivedTokenFeeConfig,
  EvmTokenFeeReader,
  MultiProvider,
  OnchainTokenFeeType,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { Address, isZeroishAddress } from '@hyperlane-xyz/utils';

import { getOwnerInsight } from './utils.js';

type FeeRouteDetail = {
  type: string;
  address: string;
  bps: number;
  percent: string;
};

export async function readFeeContractDetails(
  multiProvider: MultiProvider,
  chain: ChainName,
  tokenRouterAddress: Address,
  feeRecipientAddress: Address,
): Promise<{
  insight: string;
  description?: string;
  feeDetails?: Record<string, unknown>;
}> {
  if (isZeroishAddress(feeRecipientAddress)) {
    return { insight: `Remove fee recipient (setting to address(0))` };
  }

  try {
    const provider = multiProvider.getProvider(chain);
    const baseFee = BaseFee__factory.connect(feeRecipientAddress, provider);
    const feeType = await baseFee.feeType();

    const tokenRouter = TokenRouter__factory.connect(
      tokenRouterAddress,
      provider,
    );
    const routerDomains = await tokenRouter.domains();

    let domains = routerDomains;
    if (feeType === OnchainTokenFeeType.RoutingFee) {
      const routingFee = RoutingFee__factory.connect(
        feeRecipientAddress,
        provider,
      );
      const feeDomains = await routingFee.domains();
      const domainSet = new Set([...routerDomains, ...feeDomains]);
      domains = Array.from(domainSet);
    }

    const feeReader = new EvmTokenFeeReader(multiProvider, chain);
    const feeConfig = await feeReader.deriveTokenFeeConfig({
      address: feeRecipientAddress,
      routingDestinations: domains,
    });

    return await formatFeeConfig(chain, feeConfig);
  } catch {
    return { insight: `Set fee recipient to ${feeRecipientAddress}` };
  }
}

export async function formatFeeConfig(
  chain: ChainName,
  feeConfig: DerivedTokenFeeConfig,
): Promise<{
  insight: string;
  description: string;
  feeDetails: Record<string, unknown>;
}> {
  const ownerInsight = await getOwnerInsight(chain, feeConfig.owner);

  if (feeConfig.type === TokenFeeType.LinearFee) {
    const bps = feeConfig.bps ? Number(feeConfig.bps) : 0;
    const percentFormatted = (bps / 100).toFixed(2);

    const description = `LinearFee contract (${percentFormatted}% fee, owner: ${ownerInsight})`;
    return {
      insight: `Set fee recipient to ${description}`,
      description,
      feeDetails: {
        type: 'LinearFee',
        address: feeConfig.address,
        token: feeConfig.token,
        owner: feeConfig.owner,
        bps,
        percent: `${percentFormatted}%`,
      },
    };
  }

  if (feeConfig.type === TokenFeeType.RoutingFee) {
    const routes: Record<string, unknown> = {};
    const routeInsights: string[] = [];

    for (const [chainName, subConfig] of Object.entries(
      feeConfig.feeContracts || {},
    )) {
      const bps = subConfig.bps ? Number(subConfig.bps) : 0;
      const percent = (bps / 100).toFixed(2);

      routes[chainName] = {
        type: subConfig.type,
        address: subConfig.address,
        bps,
        percent: `${percent}%`,
      };

      if (subConfig.type === TokenFeeType.LinearFee) {
        routeInsights.push(`${chainName}: ${percent}%`);
      } else {
        routeInsights.push(`${chainName}: ${subConfig.type}`);
      }
    }

    const routeCount = Object.keys(routes).length;
    const routeSummary =
      routeCount <= 3
        ? routeInsights.join(', ')
        : `${routeCount} routes configured`;

    const description = `RoutingFee contract (${routeSummary}, owner: ${ownerInsight})`;
    return {
      insight: `Set fee recipient to ${description}`,
      description,
      feeDetails: {
        type: 'RoutingFee',
        address: feeConfig.address,
        token: feeConfig.token,
        owner: feeConfig.owner,
        routes,
      },
    };
  }

  if (feeConfig.type === TokenFeeType.CrossCollateralRoutingFee) {
    const routes: Record<string, Record<string, FeeRouteDetail>> = {};
    const routeInsights: string[] = [];

    for (const [chainName, routerConfigs] of Object.entries(
      feeConfig.feeContracts || {},
    )) {
      const routerEntries = Object.entries(routerConfigs);
      routes[chainName] = Object.fromEntries(
        routerEntries.map(([routerKey, subConfig]) => {
          const bps = subConfig.bps ? Number(subConfig.bps) : 0;
          const percent = (bps / 100).toFixed(2);

          return [
            routerKey,
            {
              type: subConfig.type,
              address: subConfig.address,
              bps,
              percent: `${percent}%`,
            },
          ];
        }),
      );

      routeInsights.push(
        `${chainName}: ${routerEntries.length} router${routerEntries.length === 1 ? '' : 's'}`,
      );
    }

    const routeCount = Object.keys(routes).length;
    const routeSummary =
      routeCount <= 3
        ? routeInsights.join(', ')
        : `${routeCount} destinations configured`;

    const description = `CrossCollateralRoutingFee contract (${routeSummary}, owner: ${ownerInsight})`;
    return {
      insight: `Set fee recipient to ${description}`,
      description,
      feeDetails: {
        type: 'CrossCollateralRoutingFee',
        address: feeConfig.address,
        owner: feeConfig.owner,
        routes,
      },
    };
  }

  const description = `${feeConfig.type} contract (owner: ${ownerInsight})`;
  return {
    insight: `Set fee recipient to ${description}`,
    description,
    feeDetails: {
      type: feeConfig.type,
      address: feeConfig.address,
      token: feeConfig.token,
      owner: feeConfig.owner,
    },
  };
}
