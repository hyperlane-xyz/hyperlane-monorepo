import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMerkleRootWeightedMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticMessageIdWeightedMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';
import {
  DomainRoutingIsmFactory__artifact,
  ProxyAdmin__artifact,
  StaticAggregationHookFactory__artifact,
  StaticAggregationIsmFactory__artifact,
  StaticMerkleRootMultisigIsmFactory__artifact,
  StaticMerkleRootWeightedMultisigIsmFactory__artifact,
  StaticMessageIdMultisigIsmFactory__artifact,
  StaticMessageIdWeightedMultisigIsmFactory__artifact,
} from '@hyperlane-xyz/core/artifacts';

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
export type ProxyFactoryFactoriesArtifacts =
  typeof proxyFactoryFactoriesArtifacts;

type ProxyFactoryImplementations = Record<keyof ProxyFactoryFactories, string>;

export const proxyFactoryFactoriesArtifacts: Record<
  keyof ProxyFactoryFactories | string,
  any
> = {
  staticMerkleRootMultisigIsmFactory:
    StaticMerkleRootMultisigIsmFactory__artifact,
  staticMessageIdMultisigIsmFactory:
    StaticMessageIdMultisigIsmFactory__artifact,
  staticAggregationIsmFactory: StaticAggregationIsmFactory__artifact,
  staticAggregationHookFactory: StaticAggregationHookFactory__artifact,
  domainRoutingIsmFactory: DomainRoutingIsmFactory__artifact,
  staticMerkleRootWeightedMultisigIsmFactory:
    StaticMerkleRootWeightedMultisigIsmFactory__artifact,
  staticMessageIdWeightedMultisigIsmFactory:
    StaticMessageIdWeightedMultisigIsmFactory__artifact,
  proxyAdmin: ProxyAdmin__artifact,
} as const;

// must match contract names for verification
export const proxyFactoryImplementations: ProxyFactoryImplementations = {
  staticMerkleRootMultisigIsmFactory: 'StaticMerkleRootMultisigIsm',
  staticMessageIdMultisigIsmFactory: 'StaticMessageIdMultisigIsm',
  staticAggregationIsmFactory: 'StaticAggregationIsm',
  staticAggregationHookFactory: 'StaticAggregationHook',
  domainRoutingIsmFactory: 'DomaingRoutingIsm',
  staticMerkleRootWeightedMultisigIsmFactory:
    'StaticMerkleRootWeightedMultisigIsm',
  staticMessageIdWeightedMultisigIsmFactory:
    'StaticMessageIdWeightedMultisigIsm',
};
