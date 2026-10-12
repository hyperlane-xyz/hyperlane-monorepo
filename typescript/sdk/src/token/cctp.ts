import { IMessageTransmitter__factory } from '@hyperlane-xyz/core';
import { objFilter, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { HypTokenConfig, isCctpTokenConfig } from './types.js';

export interface CctpDomain {
  hyperlane: number;
  circle: number;
}

/** Derives the Hyperlane/Circle domain pairs declared by a CCTP route. */
export async function deriveCctpDomains(
  multiProvider: MultiProvider,
  configMap: ChainMap<HypTokenConfig>,
): Promise<CctpDomain[]> {
  const cctpConfigs = objFilter(configMap, (_, config) =>
    isCctpTokenConfig(config),
  );
  const circleDomains = await promiseObjAll(
    objMap(cctpConfigs, (chain, config) =>
      IMessageTransmitter__factory.connect(
        config.messageTransmitter,
        multiProvider.getProvider(chain),
      ).localDomain(),
    ),
  );

  return Object.entries(circleDomains).map(([chain, circle]) => ({
    hyperlane: multiProvider.getDomainId(chain),
    circle,
  }));
}
