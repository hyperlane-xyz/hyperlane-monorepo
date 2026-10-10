import { ethers, providers } from 'ethers';

import {
  FallbackDomainRoutingHook__factory,
  IPostDispatchHook__factory,
  Mailbox__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import { fetchPackageVersion } from '@hyperlane-xyz/sdk/utils/contract';
import { Address, Logger } from '@hyperlane-xyz/utils';

export interface ChainReader {
  defaultHook(mailbox: Address): Promise<Address>;
  hookType(hook: Address): Promise<number>;
  routingOwner(routingHook: Address): Promise<Address>;
  routingFallback(routingHook: Address): Promise<Address>;
  routedHook(routingHook: Address, domainId: number): Promise<Address>;
  aggregationChildren(aggregator: Address): Promise<Address[]>;
  packageVersion(address: Address): Promise<string>;
}

// fetchPackageVersion logs raw provider errors, which can embed RPC urls; the
// error is rethrown and reported through the redacting error path instead.
export function createEvmChainReader(
  provider: providers.Provider,
  logger: Logger,
): ChainReader {
  const silentLogger = logger.child({}, { level: 'silent' });
  return {
    defaultHook: (mailbox) =>
      Mailbox__factory.connect(mailbox, provider).defaultHook(),
    hookType: (hook) =>
      IPostDispatchHook__factory.connect(hook, provider).hookType(),
    routingOwner: (routingHook) =>
      FallbackDomainRoutingHook__factory.connect(routingHook, provider).owner(),
    routingFallback: (routingHook) =>
      FallbackDomainRoutingHook__factory.connect(
        routingHook,
        provider,
      ).fallbackHook(),
    routedHook: (routingHook, domainId) =>
      FallbackDomainRoutingHook__factory.connect(routingHook, provider).hooks(
        domainId,
      ),
    aggregationChildren: (aggregator) =>
      StaticAggregationHook__factory.connect(aggregator, provider).hooks(
        ethers.constants.AddressZero,
      ),
    packageVersion: (address) =>
      fetchPackageVersion(provider, address, silentLogger),
  };
}
