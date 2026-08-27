import { expect } from 'chai';

import { HookType, IgpVersion } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

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
