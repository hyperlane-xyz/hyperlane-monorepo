import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMerkleRootWeightedMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticMessageIdWeightedMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

// Any name changes here should also be reflected in the example artifacts.
// E.g. typescript/cli/examples/contract-artifacts.yaml
export const proxyFactoryFactories = {
  staticMerkleRootMultisigIsmFactory:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  staticMessageIdMultisigIsmFactory:
    new StaticMessageIdMultisigIsmFactory__factory(),
  staticAggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  staticAggregationHookFactory: new StaticAggregationHookFactory__factory(),
  domainRoutingIsmFactory: new DomainRoutingIsmFactory__factory(),
  staticMerkleRootWeightedMultisigIsmFactory:
    new StaticMerkleRootWeightedMultisigIsmFactory__factory(),
  staticMessageIdWeightedMultisigIsmFactory:
    new StaticMessageIdWeightedMultisigIsmFactory__factory(),
};

export type ProxyFactoryFactories = typeof proxyFactoryFactories;

type ProxyFactoryImplementations = Record<keyof ProxyFactoryFactories, string>;

// must match contract names for verification
export const proxyFactoryImplementations: ProxyFactoryImplementations = {
  staticMerkleRootMultisigIsmFactory: 'StaticMerkleRootMultisigIsm',
  staticMessageIdMultisigIsmFactory: 'StaticMessageIdMultisigIsm',
  staticAggregationIsmFactory: 'StaticAggregationIsm',
  staticAggregationHookFactory: 'StaticAggregationHook',
  domainRoutingIsmFactory: 'DomainRoutingIsm',
  staticMerkleRootWeightedMultisigIsmFactory:
    'StaticMerkleRootWeightedMultisigIsm',
  staticMessageIdWeightedMultisigIsmFactory:
    'StaticMessageIdWeightedMultisigIsm',
};
