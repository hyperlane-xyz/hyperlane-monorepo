import { expect } from 'chai';

import { HookType, IgpVersion } from '../hook/types.js';
import { CompositeIsmNodeType, IsmType } from '../ism/types.js';

import { CoreConfigSchema } from './types.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';

const igpHook = (igpVersion?: IgpVersion) => ({
  type: HookType.INTERCHAIN_GAS_PAYMASTER,
  owner: ADDRESS,
  beneficiary: ADDRESS,
  oracleKey: ADDRESS,
  overhead: {},
  oracleConfig: {},
  ...(igpVersion ? { igpVersion } : {}),
});

const baseConfig = (overrides: Record<string, unknown>) => ({
  owner: ADDRESS,
  defaultIsm: ADDRESS,
  defaultHook: ADDRESS,
  requiredHook: ADDRESS,
  ...overrides,
});

describe('CoreConfigSchema warp-only default ISM guard', () => {
  const netFlow = {
    type: IsmType.NET_FLOW_RATE_LIMITED,
    warpRouter: ADDRESS,
    thresholdBps: 500,
    duration: 86400n,
    owner: ADDRESS,
  };
  const delayedFlow = {
    type: IsmType.DELAYED_FLOW_ROUTER,
    warpRouter: ADDRESS,
    thresholdBps: 500,
    maxDelay: 3600,
    duration: 86400n,
    owner: ADDRESS,
  };

  // DefaultIsm.route() returns mailbox.defaultIsm(); as the default ISM it
  // resolves to itself and recurses until out of gas.
  it('rejects DefaultIsm as the core default ISM', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({ defaultIsm: { type: IsmType.MAILBOX_DEFAULT } }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects DefaultIsm nested inside a core default ISM tree', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({
        defaultIsm: {
          type: IsmType.AGGREGATION,
          threshold: 2,
          modules: [
            { type: IsmType.TRUSTED_RELAYER, relayer: ADDRESS },
            { type: IsmType.MAILBOX_DEFAULT },
          ],
        },
      }),
    );
    expect(result.success).to.be.false;
  });

  for (const hybrid of [netFlow, delayedFlow]) {
    it(`rejects ${hybrid.type} nested in a core default ISM tree`, () => {
      const result = CoreConfigSchema.safeParse(
        baseConfig({
          defaultIsm: {
            type: IsmType.AGGREGATION,
            threshold: 2,
            modules: [
              { type: IsmType.TRUSTED_RELAYER, relayer: ADDRESS },
              hybrid,
            ],
          },
        }),
      );
      expect(result.success).to.be.false;
    });
  }

  it('still accepts an ordinary default ISM', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({
        defaultIsm: { type: IsmType.TRUSTED_RELAYER, relayer: ADDRESS },
      }),
    );
    expect(result.success).to.be.true;
  });
});

describe('CoreConfigSchema rate-limited default ISM guard', () => {
  // Composite ISM wire fields are base58 Sealevel pubkeys, unlike the
  // EVM-style ADDRESS used everywhere else in this file.
  const SEALEVEL_ADDRESS = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

  const compositeIsm = (root: Record<string, unknown>) => ({
    type: IsmType.COMPOSITE,
    owner: SEALEVEL_ADDRESS,
    root,
  });

  const rateLimitedNode = {
    type: CompositeIsmNodeType.RATE_LIMITED,
    maxCapacity: '86400',
    mailbox: SEALEVEL_ADDRESS,
  };

  const trustedRelayerNode = {
    type: CompositeIsmNodeType.TRUSTED_RELAYER,
    relayer: SEALEVEL_ADDRESS,
  };

  // Empty for a successful parse, so asserting a message is present covers
  // both "must be rejected" and "must be rejected for this reason".
  const parseIssues = (defaultIsm: unknown): string[] => {
    const result = CoreConfigSchema.safeParse(baseConfig({ defaultIsm }));
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  const RATE_LIMITED_ISM_MESSAGE =
    'RateLimitedIsm cannot be used as a core default ISM';
  const COMPOSITE_MESSAGE =
    "A compositeIsm 'rateLimited' node cannot be used in a core default ISM";

  it('rejects a rateLimitedIsm as the core default ISM', () => {
    expect(
      parseIssues({ type: IsmType.RATE_LIMITED, maxCapacity: '86400' }),
    ).to.include(RATE_LIMITED_ISM_MESSAGE);
  });

  it('rejects a rateLimitedIsm nested in an aggregation', () => {
    expect(
      parseIssues({
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [{ type: IsmType.RATE_LIMITED, maxCapacity: '86400' }],
      }),
    ).to.include(RATE_LIMITED_ISM_MESSAGE);
  });

  interface CompositeCase {
    name: string;
    root: Record<string, unknown>;
  }

  const compositeCases: CompositeCase[] = [
    { name: 'at the tree root', root: rateLimitedNode },
    {
      name: 'inside aggregation.subIsms',
      root: {
        type: CompositeIsmNodeType.AGGREGATION,
        threshold: 1,
        subIsms: [trustedRelayerNode, rateLimitedNode],
      },
    },
    {
      name: 'inside amountRouting.upper',
      root: {
        type: CompositeIsmNodeType.AMOUNT_ROUTING,
        threshold: '1000000',
        lower: trustedRelayerNode,
        upper: rateLimitedNode,
      },
    },
    {
      name: 'inside a routing domain override',
      root: {
        type: CompositeIsmNodeType.ROUTING,
        domains: { ethereum: rateLimitedNode },
      },
    },
    {
      name: 'inside a fallbackRouting domain override',
      root: {
        type: CompositeIsmNodeType.FALLBACK_ROUTING,
        fallbackIsm: SEALEVEL_ADDRESS,
        domains: { ethereum: rateLimitedNode },
      },
    },
  ];

  for (const compositeCase of compositeCases) {
    it(`rejects a compositeIsm rateLimited node ${compositeCase.name}`, () => {
      expect(parseIssues(compositeIsm(compositeCase.root))).to.include(
        COMPOSITE_MESSAGE,
      );
    });
  }

  it('rejects a compositeIsm rateLimited node behind a routing ISM domain', () => {
    expect(
      parseIssues({
        type: IsmType.ROUTING,
        owner: ADDRESS,
        domains: { ethereum: compositeIsm(rateLimitedNode) },
      }),
    ).to.include(COMPOSITE_MESSAGE);
  });

  it('still accepts a compositeIsm without a rateLimited node', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({
        defaultIsm: compositeIsm({
          type: CompositeIsmNodeType.AGGREGATION,
          threshold: 1,
          subIsms: [
            trustedRelayerNode,
            { type: CompositeIsmNodeType.TEST, accept: true },
          ],
        }),
      }),
    );
    expect(result.success).to.be.true;
  });
});

describe('CoreConfigSchema legacy IGP / QuotedCalls guard', () => {
  it('rejects a legacy IGP hook when deployQuotedCalls is not false', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({ defaultHook: igpHook(IgpVersion.Legacy) }),
    );
    expect(result.success).to.be.false;
    if (!result.success) {
      expect(result.error.issues[0].path).to.deep.equal(['deployQuotedCalls']);
    }
  });

  it('allows a legacy IGP hook when deployQuotedCalls is false', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({
        defaultHook: igpHook(IgpVersion.Legacy),
        deployQuotedCalls: false,
      }),
    );
    expect(result.success).to.be.true;
  });

  it('allows a latest IGP hook with QuotedCalls deploying', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({ defaultHook: igpHook(IgpVersion.Latest) }),
    );
    expect(result.success).to.be.true;
  });

  it('detects a legacy IGP nested inside an aggregation hook', () => {
    const result = CoreConfigSchema.safeParse(
      baseConfig({
        requiredHook: {
          type: HookType.AGGREGATION,
          hooks: [{ type: HookType.MERKLE_TREE }, igpHook(IgpVersion.Legacy)],
        },
      }),
    );
    expect(result.success).to.be.false;
  });
});
