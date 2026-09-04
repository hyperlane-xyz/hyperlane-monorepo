import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  ArtifactNew,
  ArtifactState,
  ArtifactUnderived,
  isArtifactDeployed,
  isArtifactUnderived,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  CompositeIsmArtifactConfig,
  CompositeIsmConfig,
  CompositeIsmNodeArtifactConfig,
  CompositeIsmNodeType,
  DeployedIsmArtifact,
  DerivedIsmConfig,
  IsmArtifactConfig,
  IsmArtifactResolutionOperation,
  IsmType,
  altVMIsmTypeToProviderSdkType,
  assertRateLimitedIsmRecipientsUnset,
  assertIsmSupportedAsMailboxDefault,
  ismArtifactToDerivedConfig,
  ismConfigToArtifact,
  mergeIsmArtifacts,
  resolveIsmArtifact,
  resolveRateLimitedIsmRecipients,
} from './ism.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => {
    if (chain === 'solanamainnet') return 1399811149;
    if (chain === 'ethereum') return 1;
    return null;
  },
  getChainName: (domainId: number) => {
    if (domainId === 1399811149) return 'solanamainnet';
    if (domainId === 1) return 'ethereum';
    return null;
  },
  getKnownChainNames: () => ['solanamainnet', 'ethereum'],
};

// Real base58 Sealevel pubkeys (not just arbitrary-length placeholder
// strings) so the artifact-conversion round-trip below is meaningful —
// provider-sdk itself does no address format validation, so a regression
// that mangled address bytes wouldn't be caught by fixtures that were never
// valid pubkeys to begin with.
const PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RELAYER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';
const MAILBOX = 'ComputeBudget111111111111111111111111111111';
const OWNER = 'Vote111111111111111111111111111111111111111';

describe('compositeIsm config <-> artifact conversion', () => {
  it('altVMIsmTypeToProviderSdkType maps COMPOSITE to compositeIsm', () => {
    expect(altVMIsmTypeToProviderSdkType(AltVMIsmType.COMPOSITE)).to.equal(
      IsmType.COMPOSITE,
    );
  });

  it('converts a nested tree from chain-name to domain-ID keyed domains', () => {
    const config: CompositeIsmConfig = {
      type: IsmType.COMPOSITE,
      owner: OWNER,
      root: {
        type: CompositeIsmNodeType.AGGREGATION,
        threshold: 2,
        subIsms: [
          { type: CompositeIsmNodeType.TRUSTED_RELAYER, relayer: RELAYER },
          {
            type: CompositeIsmNodeType.ROUTING,
            domains: {
              solanamainnet: { type: CompositeIsmNodeType.TEST, accept: true },
            },
          },
          {
            type: CompositeIsmNodeType.AMOUNT_ROUTING,
            threshold: '1000000',
            lower: { type: CompositeIsmNodeType.PAUSABLE, paused: false },
            upper: {
              type: CompositeIsmNodeType.RATE_LIMITED,
              maxCapacity: '86400',
              mailbox: MAILBOX,
            },
          },
        ],
      },
    };

    const artifact = ismConfigToArtifact(config, chainLookup);
    expect(artifact.artifactState).to.equal(ArtifactState.NEW);

    assert(artifact.config.type === IsmType.COMPOSITE, 'expected compositeIsm');
    const artifactConfig = artifact.config;
    expect(artifactConfig.type).to.equal(IsmType.COMPOSITE);
    expect(artifactConfig.owner).to.equal(OWNER);
    assert(
      artifactConfig.root.type === CompositeIsmNodeType.AGGREGATION,
      'expected aggregation',
    );
    expect(artifactConfig.root.threshold).to.equal(2);

    const [relayerNode, routingNode, amountRoutingNode] =
      artifactConfig.root.subIsms;
    expect(relayerNode).to.deep.equal({
      type: CompositeIsmNodeType.TRUSTED_RELAYER,
      relayer: RELAYER,
    });

    assert(
      routingNode.type === CompositeIsmNodeType.ROUTING,
      'expected routing',
    );
    // chain name -> domain ID conversion happened
    expect(routingNode.domains).to.deep.equal({
      1399811149: { type: CompositeIsmNodeType.TEST, accept: true },
    });

    assert(
      amountRoutingNode.type === CompositeIsmNodeType.AMOUNT_ROUTING,
      'expected amountRouting',
    );
    expect(amountRoutingNode.threshold).to.equal('1000000');
    expect(amountRoutingNode.lower).to.deep.equal({
      type: CompositeIsmNodeType.PAUSABLE,
      paused: false,
    });
    expect(amountRoutingNode.upper).to.deep.equal({
      type: CompositeIsmNodeType.RATE_LIMITED,
      maxCapacity: '86400',
      mailbox: MAILBOX,
    });
  });

  it('skips domains for unknown chain names, matching domainRoutingIsm', () => {
    const config: CompositeIsmConfig = {
      type: IsmType.COMPOSITE,
      owner: OWNER,
      root: {
        type: CompositeIsmNodeType.ROUTING,
        domains: {
          solanamainnet: { type: CompositeIsmNodeType.TEST, accept: true },
          unknownchain: { type: CompositeIsmNodeType.TEST, accept: false },
        },
      },
    };

    const artifact = ismConfigToArtifact(config, chainLookup);
    assert(artifact.config.type === IsmType.COMPOSITE, 'expected compositeIsm');
    const artifactConfig = artifact.config;
    assert(
      artifactConfig.root.type === CompositeIsmNodeType.ROUTING,
      'expected routing',
    );
    expect(Object.keys(artifactConfig.root.domains ?? {})).to.deep.equal([
      '1399811149',
    ]);
  });

  it('converts domain-ID keyed domains back to chain names and attaches address', () => {
    const deployedArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.COMPOSITE,
        owner: OWNER,
        root: {
          type: CompositeIsmNodeType.FALLBACK_ROUTING,
          fallbackIsm: RELAYER,
          domains: {
            1399811149: { type: CompositeIsmNodeType.TEST, accept: true },
          },
        },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const derived = ismArtifactToDerivedConfig(deployedArtifact, chainLookup);
    const expected: DerivedIsmConfig = {
      type: IsmType.COMPOSITE,
      owner: OWNER,
      address: PROGRAM_ADDRESS,
      root: {
        type: CompositeIsmNodeType.FALLBACK_ROUTING,
        fallbackIsm: RELAYER,
        domains: {
          solanamainnet: { type: CompositeIsmNodeType.TEST, accept: true },
        },
      },
    };
    expect(derived).to.deep.equal(expected);
  });

  it('skips domains for unknown domain IDs when deriving config', () => {
    const deployedArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.COMPOSITE,
        owner: OWNER,
        root: {
          type: CompositeIsmNodeType.ROUTING,
          domains: {
            1399811149: { type: CompositeIsmNodeType.TEST, accept: true },
            999999999: { type: CompositeIsmNodeType.TEST, accept: false },
          },
        },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const derived = ismArtifactToDerivedConfig(deployedArtifact, chainLookup);
    assert(
      derived.type === IsmType.COMPOSITE &&
        derived.root.type === CompositeIsmNodeType.ROUTING,
      'expected compositeIsm/routing',
    );
    expect(Object.keys(derived.root.domains ?? {})).to.deep.equal([
      'solanamainnet',
    ]);
  });

  it('does not recurse when merging — treats compositeIsm as self-diffing', () => {
    const currentArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.COMPOSITE,
        owner: OWNER,
        root: { type: CompositeIsmNodeType.TEST, accept: true },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const expectedArtifact: ArtifactNew<IsmArtifactConfig> = {
      artifactState: ArtifactState.NEW,
      config: {
        type: IsmType.COMPOSITE,
        owner: OWNER,
        // Different tree — mergeIsmArtifacts should NOT try to reconcile
        // this itself; it just passes the expected config through, leaving
        // the actual diffing to SvmCompositeIsmWriter.update().
        root: { type: CompositeIsmNodeType.PAUSABLE, paused: true },
      },
    };

    const result = mergeIsmArtifacts(currentArtifact, expectedArtifact);
    expect(isArtifactDeployed(result)).to.be.true;
    assert(isArtifactDeployed(result), 'expected DEPLOYED artifact');
    expect(result.config).to.deep.equal(expectedArtifact.config);
    expect(result.deployed).to.deep.equal({ address: PROGRAM_ADDRESS });
  });

  it('deploys new when type changes away from compositeIsm', () => {
    const currentArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.COMPOSITE,
        owner: OWNER,
        root: { type: CompositeIsmNodeType.TEST, accept: true },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const expectedArtifact: ArtifactNew<IsmArtifactConfig> = {
      artifactState: ArtifactState.NEW,
      config: { type: IsmType.TEST_ISM },
    };

    const result = mergeIsmArtifacts(currentArtifact, expectedArtifact);
    expect(result.artifactState).to.equal(ArtifactState.NEW);
    expect(result.config).to.deep.equal({ type: IsmType.TEST_ISM });
  });
});

// Sealevel pubkey standing in for the deployed warp router the ISM protects,
// and its 32-byte form. The expected hex is pinned rather than recomputed
// from addressToBytes32 so the test also covers the base58 decoding itself.
const WARP_ROUTER_BYTES32 = [
  '0x06ddf6e1d765a193d9cbe146ceeb79ac',
  '1cb485ed5f5b37913a8cf5857eff00a9',
].join('');
const WARP_ROUTER = {
  address: PROGRAM_ADDRESS,
  toBytes32: () => WARP_ROUTER_BYTES32,
};
const OTHER_BYTES32 = [
  '0x7faee05ac5f8599a177feee8cf9b710f',
  'fd41880c47a109cf020c4d9a95b0d27c',
].join('');
const CONTEXT = 'chain solanamainnet';

const RATE_LIMITED_DOMAIN_ID = 1;

function rateLimitedNode(recipient?: string): CompositeIsmNodeArtifactConfig {
  return recipient === undefined
    ? {
        type: CompositeIsmNodeType.RATE_LIMITED,
        maxCapacity: '86400',
        mailbox: MAILBOX,
      }
    : {
        type: CompositeIsmNodeType.RATE_LIMITED,
        maxCapacity: '86400',
        mailbox: MAILBOX,
        recipient,
      };
}

function compositeIsm(
  root: CompositeIsmNodeArtifactConfig,
): CompositeIsmArtifactConfig {
  return { type: IsmType.COMPOSITE, owner: OWNER, root };
}

function domainRoutingIsm(nestedConfig: IsmArtifactConfig): IsmArtifactConfig {
  return {
    type: IsmType.ROUTING,
    owner: OWNER,
    domains: {
      [RATE_LIMITED_DOMAIN_ID]: {
        artifactState: ArtifactState.NEW,
        config: nestedConfig,
      },
    },
  };
}

function newIsmArtifact(
  config: IsmArtifactConfig,
): ArtifactNew<IsmArtifactConfig> {
  return { artifactState: ArtifactState.NEW, config };
}

function extractDomainIsm(config: IsmArtifactConfig): IsmArtifactConfig {
  assert(config.type === IsmType.ROUTING, 'expected domainRoutingIsm');
  const domainIsm = config.domains[RATE_LIMITED_DOMAIN_ID];
  assert(domainIsm, `expected domain ${RATE_LIMITED_DOMAIN_ID}`);
  assert(!isArtifactUnderived(domainIsm), 'expected an expanded domain ISM');
  return domainIsm.config;
}

interface NestingCase {
  name: string;
  /** Places `node` at the position under test within a fresh tree. */
  wrap: (
    node: CompositeIsmNodeArtifactConfig,
  ) => CompositeIsmNodeArtifactConfig;
  /** Pulls the same position back out of a resolved tree. */
  extract: (
    root: CompositeIsmNodeArtifactConfig,
  ) => CompositeIsmNodeArtifactConfig;
}

const nestingCases: NestingCase[] = [
  {
    name: 'at the tree root',
    wrap: (node) => node,
    extract: (root) => root,
  },
  {
    name: 'inside aggregation.subIsms',
    wrap: (node) => ({
      type: CompositeIsmNodeType.AGGREGATION,
      threshold: 1,
      subIsms: [{ type: CompositeIsmNodeType.TEST, accept: true }, node],
    }),
    extract: (root) => {
      assert(
        root.type === CompositeIsmNodeType.AGGREGATION,
        'expected aggregation',
      );
      return root.subIsms[1];
    },
  },
  {
    name: 'inside amountRouting.lower',
    wrap: (node) => ({
      type: CompositeIsmNodeType.AMOUNT_ROUTING,
      threshold: '1000000',
      lower: node,
      upper: { type: CompositeIsmNodeType.TEST, accept: true },
    }),
    extract: (root) => {
      assert(
        root.type === CompositeIsmNodeType.AMOUNT_ROUTING,
        'expected amountRouting',
      );
      return root.lower;
    },
  },
  {
    name: 'inside amountRouting.upper',
    wrap: (node) => ({
      type: CompositeIsmNodeType.AMOUNT_ROUTING,
      threshold: '1000000',
      lower: { type: CompositeIsmNodeType.TEST, accept: true },
      upper: node,
    }),
    extract: (root) => {
      assert(
        root.type === CompositeIsmNodeType.AMOUNT_ROUTING,
        'expected amountRouting',
      );
      return root.upper;
    },
  },
  {
    name: 'inside a routing domain override',
    wrap: (node) => ({
      type: CompositeIsmNodeType.ROUTING,
      domains: { [RATE_LIMITED_DOMAIN_ID]: node },
    }),
    extract: (root) => {
      assert(root.type === CompositeIsmNodeType.ROUTING, 'expected routing');
      const domain = root.domains?.[RATE_LIMITED_DOMAIN_ID];
      assert(domain, `expected domain ${RATE_LIMITED_DOMAIN_ID}`);
      return domain;
    },
  },
  {
    name: 'inside a fallbackRouting domain override',
    wrap: (node) => ({
      type: CompositeIsmNodeType.FALLBACK_ROUTING,
      fallbackIsm: RELAYER,
      domains: { [RATE_LIMITED_DOMAIN_ID]: node },
    }),
    extract: (root) => {
      assert(
        root.type === CompositeIsmNodeType.FALLBACK_ROUTING,
        'expected fallbackRouting',
      );
      const domain = root.domains?.[RATE_LIMITED_DOMAIN_ID];
      assert(domain, `expected domain ${RATE_LIMITED_DOMAIN_ID}`);
      return domain;
    },
  },
];

describe('compositeIsm rateLimited recipient resolution', () => {
  describe('resolveRateLimitedIsmRecipients', () => {
    for (const testCase of nestingCases) {
      it(`fills an unset recipient ${testCase.name}`, () => {
        const resolved = resolveRateLimitedIsmRecipients(
          compositeIsm(testCase.wrap(rateLimitedNode())),
          WARP_ROUTER,
          CONTEXT,
        );
        assert(resolved.type === IsmType.COMPOSITE, 'expected compositeIsm');
        const node = testCase.extract(resolved.root);
        assert(
          node.type === CompositeIsmNodeType.RATE_LIMITED,
          'expected rateLimited',
        );
        expect(node.recipient).to.equal(WARP_ROUTER_BYTES32);
        expect(node.maxCapacity).to.equal('86400');
        expect(node.mailbox).to.equal(MAILBOX);
      });

      it(`accepts a matching recipient ${testCase.name}`, () => {
        const resolved = resolveRateLimitedIsmRecipients(
          compositeIsm(
            testCase.wrap(
              rateLimitedNode(
                `0x${WARP_ROUTER_BYTES32.slice(2).toUpperCase()}`,
              ),
            ),
          ),
          WARP_ROUTER,
          CONTEXT,
        );
        assert(resolved.type === IsmType.COMPOSITE, 'expected compositeIsm');
        const node = testCase.extract(resolved.root);
        assert(
          node.type === CompositeIsmNodeType.RATE_LIMITED,
          'expected rateLimited',
        );
        expect(node.recipient).to.equal(WARP_ROUTER_BYTES32);
      });

      it(`rejects a mismatched recipient ${testCase.name}`, () => {
        expect(() =>
          resolveRateLimitedIsmRecipients(
            compositeIsm(testCase.wrap(rateLimitedNode(OTHER_BYTES32))),
            WARP_ROUTER,
            CONTEXT,
          ),
        ).to.throw(WARP_ROUTER_BYTES32);
      });
    }

    it('preserves every sibling field of the surrounding tree', () => {
      const config = compositeIsm({
        type: CompositeIsmNodeType.AGGREGATION,
        threshold: 2,
        subIsms: [
          {
            type: CompositeIsmNodeType.MULTISIG_MESSAGE_ID,
            validators: [RELAYER],
            threshold: 1,
          },
          {
            type: CompositeIsmNodeType.FALLBACK_ROUTING,
            fallbackIsm: RELAYER,
            domains: {
              [RATE_LIMITED_DOMAIN_ID]: rateLimitedNode(),
            },
          },
        ],
      });

      const resolved = resolveRateLimitedIsmRecipients(
        config,
        WARP_ROUTER,
        CONTEXT,
      );

      expect(resolved).to.deep.equal(
        compositeIsm({
          type: CompositeIsmNodeType.AGGREGATION,
          threshold: 2,
          subIsms: [
            {
              type: CompositeIsmNodeType.MULTISIG_MESSAGE_ID,
              validators: [RELAYER],
              threshold: 1,
            },
            {
              type: CompositeIsmNodeType.FALLBACK_ROUTING,
              fallbackIsm: RELAYER,
              domains: {
                [RATE_LIMITED_DOMAIN_ID]: rateLimitedNode(WARP_ROUTER_BYTES32),
              },
            },
          ],
        }),
      );
    });

    it('passes through a router address that is already 32-byte hex', () => {
      const hexRouter = [
        '0x726F757465725F617070000000000000',
        '00000000000001000000000000000000',
      ].join('');
      const resolved = resolveRateLimitedIsmRecipients(
        compositeIsm(rateLimitedNode()),
        { address: hexRouter, toBytes32: () => hexRouter },
        CONTEXT,
      );
      assert(resolved.type === IsmType.COMPOSITE, 'expected compositeIsm');
      assert(
        resolved.root.type === CompositeIsmNodeType.RATE_LIMITED,
        'expected a rateLimited root',
      );
      expect(resolved.root.recipient).to.equal(hexRouter.toLowerCase());
    });

    it('leaves a non-composite ISM untouched', () => {
      const config: IsmArtifactConfig = { type: IsmType.TEST_ISM };
      expect(
        resolveRateLimitedIsmRecipients(config, WARP_ROUTER, CONTEXT),
      ).to.equal(config);
    });

    it('keeps routing domain overrides without a rateLimited node intact', () => {
      const config = compositeIsm({
        type: CompositeIsmNodeType.ROUTING,
        domains: {
          [RATE_LIMITED_DOMAIN_ID]: {
            type: CompositeIsmNodeType.TEST,
            accept: true,
          },
        },
      });
      expect(
        resolveRateLimitedIsmRecipients(config, WARP_ROUTER, CONTEXT),
      ).to.deep.equal(config);
    });

    it('preserves omitted routing domains', () => {
      for (const root of [
        { type: CompositeIsmNodeType.ROUTING },
        {
          type: CompositeIsmNodeType.FALLBACK_ROUTING,
          fallbackIsm: PROGRAM_ADDRESS,
        },
      ] satisfies CompositeIsmNodeArtifactConfig[]) {
        const config = compositeIsm(root);
        expect(
          resolveRateLimitedIsmRecipients(config, WARP_ROUTER, CONTEXT),
        ).to.deep.equal(config);
      }
    });

    it('resolves a composite nested inside a domainRoutingIsm artifact', () => {
      const resolved = resolveRateLimitedIsmRecipients(
        domainRoutingIsm(compositeIsm(rateLimitedNode())),
        WARP_ROUTER,
        CONTEXT,
      );
      const nested = extractDomainIsm(resolved);
      assert(nested.type === IsmType.COMPOSITE, 'expected compositeIsm');
      assert(
        nested.root.type === CompositeIsmNodeType.RATE_LIMITED,
        'expected rateLimited',
      );
      expect(nested.root.recipient).to.equal(WARP_ROUTER_BYTES32);
    });

    it('preserves an implicit NEW nested artifact shape', () => {
      const config: IsmArtifactConfig = {
        type: IsmType.ROUTING,
        owner: OWNER,
        domains: {
          [RATE_LIMITED_DOMAIN_ID]: {
            config: compositeIsm(rateLimitedNode()),
          },
        },
      };
      const resolved = resolveRateLimitedIsmRecipients(
        config,
        WARP_ROUTER,
        CONTEXT,
      );
      assert(resolved.type === IsmType.ROUTING, 'expected domainRoutingIsm');
      const domainIsm = resolved.domains[RATE_LIMITED_DOMAIN_ID];
      expect(Object.hasOwn(domainIsm, 'artifactState')).to.be.false;
    });

    it('preserves a nested DEPLOYED artifact while resolving its config', () => {
      const config: IsmArtifactConfig = {
        type: IsmType.ROUTING,
        owner: OWNER,
        domains: {
          [RATE_LIMITED_DOMAIN_ID]: {
            artifactState: ArtifactState.DEPLOYED,
            config: compositeIsm(rateLimitedNode()),
            deployed: { address: PROGRAM_ADDRESS },
          },
        },
      };
      const resolved = resolveRateLimitedIsmRecipients(
        config,
        WARP_ROUTER,
        CONTEXT,
      );
      assert(resolved.type === IsmType.ROUTING, 'expected domainRoutingIsm');
      const domainIsm = resolved.domains[RATE_LIMITED_DOMAIN_ID];
      assert(isArtifactDeployed(domainIsm), 'expected a deployed domain ISM');
      expect(domainIsm.deployed.address).to.equal(PROGRAM_ADDRESS);
      assert(
        domainIsm.config.type === IsmType.COMPOSITE,
        'expected compositeIsm',
      );
      assert(
        domainIsm.config.root.type === CompositeIsmNodeType.RATE_LIMITED,
        'expected rateLimited',
      );
      expect(domainIsm.config.root.recipient).to.equal(WARP_ROUTER_BYTES32);
    });

    it('leaves an UNDERIVED nested artifact untouched', () => {
      const config: IsmArtifactConfig = {
        type: IsmType.ROUTING,
        owner: OWNER,
        domains: {
          [RATE_LIMITED_DOMAIN_ID]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: PROGRAM_ADDRESS },
          },
        },
      };
      expect(
        resolveRateLimitedIsmRecipients(config, WARP_ROUTER, CONTEXT),
      ).to.deep.equal(config);
    });
  });

  describe('resolveIsmArtifact', () => {
    it('does not parse a router address when no contextual ISM needs it', () => {
      const newRouting: ArtifactNew<IsmArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: newIsmArtifact({
              type: IsmType.TEST_ISM,
            }),
          },
        },
      };
      const deployedTest: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM },
        deployed: { address: PROGRAM_ADDRESS },
      };
      const resolutionContext = {
        operation: IsmArtifactResolutionOperation.CREATE,
        warpRouter: {
          address: 'cosmos1deadbeef',
          toBytes32: () => {
            throw new Error('must remain lazy');
          },
        },
        context: CONTEXT,
      } as const;

      expect(() =>
        resolveIsmArtifact(newRouting, resolutionContext),
      ).to.not.throw();
      expect(() =>
        resolveIsmArtifact(deployedTest, resolutionContext),
      ).to.not.throw();
    });

    it('resolves NEW descendants of a NEW routing artifact', () => {
      const artifact: ArtifactNew<IsmArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: domainRoutingIsm(compositeIsm(rateLimitedNode())),
      };
      const resolved = resolveIsmArtifact(artifact, {
        operation: IsmArtifactResolutionOperation.CREATE,
        warpRouter: WARP_ROUTER,
        context: CONTEXT,
      });
      const nested = extractDomainIsm(resolved.config);
      assert(nested.type === IsmType.COMPOSITE, 'expected compositeIsm');
      assert(
        nested.root.type === CompositeIsmNodeType.RATE_LIMITED,
        'expected rateLimited',
      );
      expect(nested.root.recipient).to.equal(WARP_ROUTER_BYTES32);
    });

    it('validates and preserves DEPLOYED descendants of a NEW routing artifact', () => {
      const deployedDomainIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: compositeIsm(rateLimitedNode(WARP_ROUTER_BYTES32)),
        deployed: { address: PROGRAM_ADDRESS },
      };
      const artifact: ArtifactNew<IsmArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: { [RATE_LIMITED_DOMAIN_ID]: deployedDomainIsm },
        },
      };
      const resolved = resolveIsmArtifact(artifact, {
        operation: IsmArtifactResolutionOperation.CREATE,
        warpRouter: WARP_ROUTER,
        context: CONTEXT,
      });
      assert(
        resolved.config.type === IsmType.ROUTING,
        'expected domainRoutingIsm',
      );
      expect(resolved.config.domains[RATE_LIMITED_DOMAIN_ID]).to.equal(
        deployedDomainIsm,
      );
    });

    it('rejects a mismatched DEPLOYED descendant of a NEW routing artifact', () => {
      const artifact: ArtifactNew<IsmArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: {
              artifactState: ArtifactState.DEPLOYED,
              config: compositeIsm(rateLimitedNode(OTHER_BYTES32)),
              deployed: { address: PROGRAM_ADDRESS },
            },
          },
        },
      };
      expect(() =>
        resolveIsmArtifact(artifact, {
          operation: IsmArtifactResolutionOperation.CREATE,
          warpRouter: WARP_ROUTER,
          context: CONTEXT,
        }),
      ).to.throw(WARP_ROUTER_BYTES32);
    });

    it('preserves UNDERIVED descendants of a NEW routing artifact', () => {
      const domainIsm: ArtifactUnderived<DeployedIsmArtifact['deployed']> = {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: PROGRAM_ADDRESS },
      };
      const artifact: ArtifactNew<IsmArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: { [RATE_LIMITED_DOMAIN_ID]: domainIsm },
        },
      };
      const resolved = resolveIsmArtifact(artifact, {
        operation: IsmArtifactResolutionOperation.CREATE,
        warpRouter: WARP_ROUTER,
        context: CONTEXT,
      });
      assert(
        resolved.config.type === IsmType.ROUTING,
        'expected domainRoutingIsm',
      );
      expect(resolved.config.domains[RATE_LIMITED_DOMAIN_ID]).to.equal(
        domainIsm,
      );
    });

    it('validates and preserves a DEPLOYED routing root during warp create', () => {
      const artifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: {
              artifactState: ArtifactState.DEPLOYED,
              config: compositeIsm(rateLimitedNode(WARP_ROUTER_BYTES32)),
              deployed: { address: PROGRAM_ADDRESS },
            },
          },
        },
        deployed: { address: PROGRAM_ADDRESS },
      };
      expect(
        resolveIsmArtifact(artifact, {
          operation: IsmArtifactResolutionOperation.CREATE,
          warpRouter: WARP_ROUTER,
          context: CONTEXT,
        }),
      ).to.equal(artifact);
    });

    it('rejects a NEW descendant in a DEPLOYED routing root during warp create', () => {
      const artifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: {
              artifactState: ArtifactState.NEW,
              config: compositeIsm(rateLimitedNode()),
            },
          },
        },
        deployed: { address: PROGRAM_ADDRESS },
      };
      expect(() =>
        resolveIsmArtifact(artifact, {
          operation: IsmArtifactResolutionOperation.CREATE,
          warpRouter: WARP_ROUTER,
          context: CONTEXT,
        }),
      ).to.throw(/DEPLOYED ISM.*NEW descendant/);
    });

    it('rejects a mismatched rateLimited descendant in a DEPLOYED routing root', () => {
      const artifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: {
              artifactState: ArtifactState.DEPLOYED,
              config: compositeIsm(rateLimitedNode(OTHER_BYTES32)),
              deployed: { address: PROGRAM_ADDRESS },
            },
          },
        },
        deployed: { address: PROGRAM_ADDRESS },
      };
      expect(() =>
        resolveIsmArtifact(artifact, {
          operation: IsmArtifactResolutionOperation.CREATE,
          warpRouter: WARP_ROUTER,
          context: CONTEXT,
        }),
      ).to.throw(WARP_ROUTER_BYTES32);
    });

    it('resolves DEPLOYED descendants when updating a DEPLOYED routing artifact', () => {
      const artifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: {
            [RATE_LIMITED_DOMAIN_ID]: {
              artifactState: ArtifactState.DEPLOYED,
              config: compositeIsm(rateLimitedNode()),
              deployed: { address: PROGRAM_ADDRESS },
            },
          },
        },
        deployed: { address: PROGRAM_ADDRESS },
      };
      const resolved = resolveIsmArtifact(artifact, {
        operation: IsmArtifactResolutionOperation.UPDATE,
        warpRouter: WARP_ROUTER,
        context: CONTEXT,
      });
      const nested = extractDomainIsm(resolved.config);
      assert(nested.type === IsmType.COMPOSITE, 'expected compositeIsm');
      assert(
        nested.root.type === CompositeIsmNodeType.RATE_LIMITED,
        'expected rateLimited',
      );
      expect(nested.root.recipient).to.equal(WARP_ROUTER_BYTES32);
    });
  });

  describe('assertRateLimitedIsmRecipientsUnset', () => {
    for (const testCase of nestingCases) {
      it(`rejects a recipient written out ${testCase.name}`, () => {
        expect(() => {
          assertRateLimitedIsmRecipientsUnset(
            newIsmArtifact(
              compositeIsm(testCase.wrap(rateLimitedNode(WARP_ROUTER_BYTES32))),
            ),
            CONTEXT,
          );
        }).to.throw(CONTEXT);
      });

      it(`accepts an unset recipient ${testCase.name}`, () => {
        expect(() => {
          assertRateLimitedIsmRecipientsUnset(
            newIsmArtifact(compositeIsm(testCase.wrap(rateLimitedNode()))),
            CONTEXT,
          );
        }).to.not.throw();
      });
    }

    it('accepts a non-composite ISM', () => {
      expect(() => {
        assertRateLimitedIsmRecipientsUnset(
          newIsmArtifact({ type: IsmType.TEST_ISM }),
          CONTEXT,
        );
      }).to.not.throw();
    });

    it('rejects a recipient nested inside a domainRoutingIsm artifact', () => {
      expect(() => {
        assertRateLimitedIsmRecipientsUnset(
          newIsmArtifact(
            domainRoutingIsm(
              compositeIsm(rateLimitedNode(WARP_ROUTER_BYTES32)),
            ),
          ),
          CONTEXT,
        );
      }).to.throw(CONTEXT);
    });

    it('accepts a recipient in a DEPLOYED descendant', () => {
      expect(() => {
        assertRateLimitedIsmRecipientsUnset(
          {
            artifactState: ArtifactState.NEW,
            config: {
              type: IsmType.ROUTING,
              owner: OWNER,
              domains: {
                [RATE_LIMITED_DOMAIN_ID]: {
                  artifactState: ArtifactState.DEPLOYED,
                  config: compositeIsm(rateLimitedNode(WARP_ROUTER_BYTES32)),
                  deployed: { address: PROGRAM_ADDRESS },
                },
              },
            },
          },
          CONTEXT,
        );
      }).to.not.throw();
    });
  });

  describe('assertIsmSupportedAsMailboxDefault', () => {
    for (const testCase of nestingCases) {
      it(`rejects a rateLimited node ${testCase.name}`, () => {
        expect(() => {
          assertIsmSupportedAsMailboxDefault(
            {
              artifactState: ArtifactState.NEW,
              config: compositeIsm(testCase.wrap(rateLimitedNode())),
            },
            CONTEXT,
          );
        }).to.throw(CONTEXT);
      });
    }

    it('accepts a composite tree without a rateLimited node', () => {
      expect(() => {
        assertIsmSupportedAsMailboxDefault(
          {
            artifactState: ArtifactState.NEW,
            config: compositeIsm({
              type: CompositeIsmNodeType.AGGREGATION,
              threshold: 1,
              subIsms: [
                {
                  type: CompositeIsmNodeType.TRUSTED_RELAYER,
                  relayer: RELAYER,
                },
              ],
            }),
          },
          CONTEXT,
        );
      }).to.not.throw();
    });

    it('accepts a non-composite ISM', () => {
      expect(() => {
        assertIsmSupportedAsMailboxDefault(
          {
            artifactState: ArtifactState.NEW,
            config: { type: IsmType.TEST_ISM },
          },
          CONTEXT,
        );
      }).to.not.throw();
    });

    it('rejects a rateLimited node nested inside a domainRoutingIsm artifact', () => {
      expect(() => {
        assertIsmSupportedAsMailboxDefault(
          {
            artifactState: ArtifactState.NEW,
            config: domainRoutingIsm(compositeIsm(rateLimitedNode())),
          },
          CONTEXT,
        );
      }).to.throw(CONTEXT);
    });

    it('accepts an opaque UNDERIVED ISM address', () => {
      expect(() => {
        assertIsmSupportedAsMailboxDefault(
          {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: PROGRAM_ADDRESS },
          },
          CONTEXT,
        );
      }).to.not.throw();
    });
  });
});
