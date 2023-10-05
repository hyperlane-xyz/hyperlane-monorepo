import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

export const factoryFactories = {
  merkleRootMultisigIsmFactory:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  messageIdMultisigIsmFactory: new StaticMessageIdMultisigIsmFactory__factory(),
  aggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  aggregationHookFactory: new StaticAggregationHookFactory__factory(),
  routingIsmFactory: new DomainRoutingIsmFactory__factory(),
};

export type FactoryFactories = typeof factoryFactories;
