import {
  DomainRoutingIsmFactory__factory,
  LegacyMultisigIsm__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

export const ismFactoryFactories = {
  merkleRootMultisigIsm: new StaticMerkleRootMultisigIsmFactory__factory(),
  messageIdMultisigIsm: new StaticMessageIdMultisigIsmFactory__factory(),
  legacyMultisigIsm: new LegacyMultisigIsm__factory(),
  aggregationIsm: new StaticAggregationIsmFactory__factory(),
  routingIsm: new DomainRoutingIsmFactory__factory(),
};

export type IsmFactoryFactories = typeof ismFactoryFactories;
