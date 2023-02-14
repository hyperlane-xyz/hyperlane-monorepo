import { ChainMap, ChainName, chainMetadata } from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../src/config';
import { MatchingList } from '../src/config/agent';

import { Contexts } from './contexts';

export const MATCHING_LIST_ALL_WILDCARDS = [
  {
    originDomain: '*',
    senderAddress: '*',
    destinationDomain: '*',
    recipientAddress: '*',
  },
];

export function helloworldMatchingList(
  helloWorldConfigs: Partial<Record<Contexts, HelloWorldConfig<ChainName>>>,
  context: Contexts,
) {
  const helloWorldConfig = helloWorldConfigs[context];
  if (!helloWorldConfig) {
    throw Error(`No HelloWorldConfig found for context ${context}`);
  }
  return routerMatchingList(helloWorldConfig.addresses);
}

export function routerMatchingList(routers: ChainMap<{ router: string }>) {
  const chains = Object.keys(routers);

  const matchingList: MatchingList = [];

  for (const source of chains) {
    for (const destination of chains) {
      if (source === destination) {
        continue;
      }

      matchingList.push({
        originDomain: chainMetadata[source].chainId,
        senderAddress: routers[source].router,
        destinationDomain: chainMetadata[destination].chainId,
        recipientAddress: routers[destination].router,
      });
    }
  }
  return matchingList;
}
