import { expect } from 'chai';

import { HookType, IgpVersion } from '../hook/types.js';

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
