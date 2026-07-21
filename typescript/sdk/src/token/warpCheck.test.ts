import type { DerivedCollateralWarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { expect } from 'chai';
import sinon from 'sinon';
import { zeroAddress } from 'viem';

import { CrossCollateralRouter__factory } from '@hyperlane-xyz/core';
import { ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  test1,
  test2,
  test3,
  testSealevelChain,
} from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import type {
  DerivedWarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
} from './types.js';
import {
  altVmScaleMismatch,
  buildAltVmWarpRouteDiff,
  buildWarpRouteDiff,
  derivedWarpConfigToCheckConfig,
  expandedDeployConfigToAltVmCheckConfig,
  getScaleViolations,
  normalizeAltVmExpectedTokenType,
} from './warpCheck.js';

const MAILBOX = '0x000000000000000000000000000000000000b001';
const OWNER = '0x000000000000000000000000000000000000dEaD';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type ScaleValidationParams = Parameters<typeof getScaleViolations>[0];
type ScaleValidationWarpRouteConfig = ScaleValidationParams['warpRouteConfig'];

function buildMultiProvider(): MultiProvider {
  return new MultiProvider({
    [test1.name]: test1,
    [test2.name]: test2,
    [testSealevelChain.name]: testSealevelChain,
  });
}

function stubConfiguredRouterMetadata({
  decimals,
  scale,
}: {
  decimals: number;
  scale?: Awaited<ReturnType<EvmWarpRouteReader['fetchScale']>>;
}) {
  const connectStub = sinon
    .stub(CrossCollateralRouter__factory, 'connect')
    .returns({
      wrappedToken: async () => TOKEN_B,
      // CAST: unit test only uses wrappedToken()
    } as ReturnType<typeof CrossCollateralRouter__factory.connect>);

  const metadataStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchERC20Metadata')
    .resolves({
      decimals,
      isNft: false,
      name: 'TOKEN',
      symbol: 'TOKEN',
    });

  const scaleStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchScale')
    .resolves(scale);

  return { connectStub, metadataStub, scaleStub };
}

function buildCrossCollateralConfig({
  crossCollateralRouters,
  decimals,
  scale,
}: {
  crossCollateralRouters?: Record<string, string[]>;
  decimals: number;
  scale?: number;
}): ScaleValidationWarpRouteConfig[string] {
  return {
    crossCollateralRouters,
    decimals,
    mailbox: MAILBOX,
    name: 'TOKEN',
    owner: OWNER,
    scale,
    symbol: 'TOKEN',
    token: TOKEN_A,
    type: TokenType.crossCollateral,
  };
}

describe('getScaleViolations', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('passes when an off-subroute configured CCR router shares the same effective scale', async () => {
    const { connectStub, metadataStub, scaleStub } =
      stubConfiguredRouterMetadata({ decimals: 18 });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [test2.domainId.toString()]: [addressToBytes32(ROUTER_B)],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([]);
    expect(
      connectStub.calledOnceWithExactly(ROUTER_B, sinon.match.object),
    ).to.equal(true);
    expect(metadataStub.calledOnceWithExactly(TOKEN_B)).to.equal(true);
    expect(scaleStub.calledOnceWithExactly(ROUTER_B)).to.equal(true);
  });

  it('fails when an off-subroute configured CCR router has mismatched decimals', async () => {
    stubConfiguredRouterMetadata({ decimals: 8 });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [test2.domainId.toString()]: [addressToBytes32(ROUTER_B)],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([
      {
        actual: 'invalid-or-missing',
        chain: 'route',
        expected: 'consistent-with-decimals',
        name: 'scale',
        type: 'ScaleMismatch',
      },
    ]);
  });

  it('skips configured CCR routers on non-EVM chains', async () => {
    const connectStub = sinon.stub(CrossCollateralRouter__factory, 'connect');

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [testSealevelChain.domainId.toString()]: [
            'So11111111111111111111111111111111111111112',
          ],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([]);
    expect(connectStub.notCalled).to.equal(true);
  });
});

function buildDerivedCollateralConfig(
  overrides: Partial<DerivedCollateralWarpConfig> = {},
): DerivedCollateralWarpConfig {
  return {
    decimals: 6,
    destinationGas: {},
    hook: MAILBOX,
    interchainSecurityModule: MAILBOX,
    mailbox: MAILBOX,
    name: 'TOKEN',
    owner: OWNER,
    remoteRouters: {},
    symbol: 'TOKEN',
    token: TOKEN_A,
    type: 'collateral',
    ...overrides,
  };
}

describe('derivedWarpConfigToCheckConfig', () => {
  it('excludes decimals for CosmosNative, whose reader always returns a placeholder', () => {
    const result = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({
        decimals: 0,
        name: 'Unknown',
        symbol: 'Unknown',
      }),
      ProtocolType.CosmosNative,
    );

    expect(result.decimals).to.equal(undefined);
  });

  it('keeps decimals for protocols with reliable on-chain metadata', () => {
    const result = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({ decimals: 9 }),
      ProtocolType.Sealevel,
    );

    expect(result.decimals).to.equal(9);
  });

  it('normalizes Starknet addresses so differently-formatted equal addresses compare equal', () => {
    const short = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({ owner: '0x1abc' }),
      ProtocolType.Starknet,
    );
    const padded = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({
        owner:
          '0x0000000000000000000000000000000000000000000000000000000001abc',
      }),
      ProtocolType.Starknet,
    );

    expect(short.owner).to.equal(padded.owner);
  });

  it('never includes name/symbol, mirroring the EVM FIELDS_TO_IGNORE convention', () => {
    const result = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig(),
      ProtocolType.Sealevel,
    );

    expect(result).to.not.have.property('name');
    expect(result).to.not.have.property('symbol');
  });

  it('carries contractVersion through for comparison', () => {
    const result = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({ contractVersion: '1.2.3' }),
      ProtocolType.Sealevel,
    );

    expect(result.contractVersion).to.equal('1.2.3');
  });

  it('keeps token for collateral types (a real configured value)', () => {
    const result = derivedWarpConfigToCheckConfig(
      buildDerivedCollateralConfig({ token: TOKEN_A }),
      ProtocolType.Sealevel,
    );

    expect(result).to.have.property('token');
  });

  it('drops token for synthetic types, whose mint is a deterministic deployment artifact', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        decimals: 6,
        destinationGas: {},
        hook: MAILBOX,
        interchainSecurityModule: MAILBOX,
        mailbox: MAILBOX,
        name: 'TOKEN',
        owner: OWNER,
        remoteRouters: {},
        symbol: 'TOKEN',
        token: TOKEN_A,
        type: TokenType.synthetic,
      },
      ProtocolType.Sealevel,
    );

    expect(result).to.not.have.property('token');
  });

  it('normalizes crossCollateralRouters to lowercased, sorted, chain-keyed lists', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        ...buildDerivedCollateralConfig(),
        crossCollateralRouters: {
          [test2.name]: ['0x' + 'B'.repeat(64), '0x' + 'A'.repeat(64)],
        },
        type: 'crossCollateral',
      },
      ProtocolType.Sealevel,
    );

    expect(result.crossCollateralRouters).to.deep.equal({
      [test2.name]: ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64)],
    });
  });

  it('widens a 20-byte EVM router address to bytes32 before comparing', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        ...buildDerivedCollateralConfig(),
        crossCollateralRouters: {
          [test2.name]: [ROUTER_B],
        },
        type: 'crossCollateral',
      },
      ProtocolType.Sealevel,
    );

    expect(result.crossCollateralRouters).to.deep.equal({
      [test2.name]: [addressToBytes32(ROUTER_B).toLowerCase()],
    });
  });

  it('treats an on-chain empty crossCollateralRouters map ({}) as omitted, not a real value', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        ...buildDerivedCollateralConfig(),
        crossCollateralRouters: {},
        type: 'crossCollateral',
      },
      ProtocolType.Sealevel,
    );

    expect(result.crossCollateralRouters).to.equal(undefined);
  });

  it('treats a crossCollateralRouters map with only empty chain entries ({ chain: [] }) as omitted', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        ...buildDerivedCollateralConfig(),
        crossCollateralRouters: {
          [test2.name]: [],
        },
        type: 'crossCollateral',
      },
      ProtocolType.Sealevel,
    );

    expect(result.crossCollateralRouters).to.equal(undefined);
  });

  it('drops empty chain entries but keeps non-empty ones in a mixed crossCollateralRouters map', () => {
    const result = derivedWarpConfigToCheckConfig(
      {
        ...buildDerivedCollateralConfig(),
        crossCollateralRouters: {
          [test2.name]: [],
          [test3.name]: [ROUTER_B],
        },
        type: 'crossCollateral',
      },
      ProtocolType.Sealevel,
    );

    expect(result.crossCollateralRouters).to.deep.equal({
      [test3.name]: [addressToBytes32(ROUTER_B).toLowerCase()],
    });
  });
});

describe('altVmScaleMismatch', () => {
  it('treats undefined actual and unset expected as matching identity scale', () => {
    expect(altVmScaleMismatch(undefined, undefined)).to.equal(undefined);
  });

  it('matches a fractional on-chain scale (e.g. SVM remoteDecimalsToScale) against the equivalent expected fraction', () => {
    expect(
      altVmScaleMismatch(0.001, { denominator: 1000, numerator: 1 }),
    ).to.equal(undefined);
  });

  it('flags a fractional on-chain scale against an unset (identity) expected scale', () => {
    expect(altVmScaleMismatch(0.001, undefined)).to.not.equal(undefined);
  });

  it('flags an identity on-chain scale against a configured non-identity expected scale', () => {
    expect(
      altVmScaleMismatch(undefined, { denominator: 1000, numerator: 1 }),
    ).to.not.equal(undefined);
  });

  it('matches an integer on-chain scale against an equivalent plain-number expected scale', () => {
    expect(altVmScaleMismatch(1000, 1000)).to.equal(undefined);
  });

  // 1/scale is lossy in IEEE-754 for several of these exponents (e.g.
  // 1/1e-5 = 99999.99999999999, not exactly 100000), which used to either
  // throw or silently compare against the wrong fraction. These decimal
  // deltas are routine for SVM's remoteDecimalsToScale and the Aleo reader.
  for (const exponent of [1, 3, 5, 9, 12, 15, 18]) {
    it(`matches a 1e-${exponent} on-chain scale against the equivalent expected fraction`, () => {
      const scale = Math.pow(10, -exponent);
      expect(
        altVmScaleMismatch(scale, {
          denominator: 10 ** exponent,
          numerator: 1,
        }),
      ).to.equal(undefined);
    });
  }
});

describe('expandedDeployConfigToAltVmCheckConfig', () => {
  it("treats expandWarpDeployConfig's EVM zeroAddress ISM/hook default as unset, not user-specified", () => {
    // expandWarpDeployConfig fills in viem's zeroAddress for ISM/hook on every
    // chain that doesn't configure them, including altVM chains -- this isn't a
    // real user-specified value, so it must not be diffed against the actual
    // on-chain (non-EVM-formatted) ISM/hook address.
    const result = expandedDeployConfigToAltVmCheckConfig(
      testSealevelChain.name,
      {
        decimals: 6,
        destinationGas: {},
        hook: zeroAddress,
        interchainSecurityModule: zeroAddress,
        mailbox: MAILBOX,
        owner: OWNER,
        token: TOKEN_A,
        type: TokenType.collateral,
      },
      buildMultiProvider(),
    );

    expect(result.hook).to.equal(undefined);
    expect(result.interchainSecurityModule).to.equal(undefined);
  });

  it('drops token for synthetic types so it mirrors the reader-side exclusion', () => {
    const result = expandedDeployConfigToAltVmCheckConfig(
      testSealevelChain.name,
      {
        decimals: 6,
        destinationGas: {},
        mailbox: MAILBOX,
        owner: OWNER,
        token: TOKEN_A,
        type: TokenType.synthetic,
      },
      buildMultiProvider(),
    );

    expect(result).to.not.have.property('token');
  });
});

describe('normalizeAltVmExpectedTokenType', () => {
  it("maps the paradex-only 'collateralDex' annotation to collateral", () => {
    // collateralDex is a registry-only annotation with no SDK TokenType; the leg
    // is a standard collateral router on-chain, so the checker must treat the two
    // as equivalent instead of false-flagging a `type` ConfigMismatch.
    expect(normalizeAltVmExpectedTokenType('collateralDex')).to.equal(
      TokenType.collateral,
    );
  });

  it('leaves known token types unchanged', () => {
    expect(normalizeAltVmExpectedTokenType(TokenType.collateral)).to.equal(
      TokenType.collateral,
    );
    expect(normalizeAltVmExpectedTokenType(TokenType.synthetic)).to.equal(
      TokenType.synthetic,
    );
    expect(normalizeAltVmExpectedTokenType(TokenType.native)).to.equal(
      TokenType.native,
    );
  });
});

describe('buildAltVmWarpRouteDiff', () => {
  const baseConfig = {
    destinationGas: {},
    mailbox: MAILBOX,
    owner: OWNER,
    remoteRouters: {},
    type: TokenType.collateral,
  };

  it('does not flag an on-chain zero-address ISM/hook when the deploy config omits it', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          hook: '0x0000000000000000000000000000000000000000',
          interchainSecurityModule:
            '0x0000000000000000000000000000000000000000',
        },
      },
      { [testSealevelChain.name]: { ...baseConfig } },
    );

    expect(diff).to.deep.equal({});
  });

  it('flags a chain present on-chain but missing from the expected config', () => {
    const diff = buildAltVmWarpRouteDiff(
      { [testSealevelChain.name]: { ...baseConfig } },
      {},
    );

    expect(diff).to.deep.equal({
      [testSealevelChain.name]: {
        route: { actual: 'present', expected: 'missing' },
      },
    });
  });

  it('flags a chain expected but missing on-chain', () => {
    const diff = buildAltVmWarpRouteDiff(
      {},
      { [testSealevelChain.name]: { ...baseConfig } },
    );

    expect(diff).to.deep.equal({
      [testSealevelChain.name]: {
        route: { actual: 'missing', expected: 'present' },
      },
    });
  });

  it('does not flag a contractVersion drift when the deploy config does not opt in', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          contractVersion: '1.0.0',
        },
      },
      { [testSealevelChain.name]: { ...baseConfig } },
    );

    expect(diff).to.deep.equal({});
  });

  it('flags a contractVersion mismatch when the deploy config opts in', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          contractVersion: '1.0.0',
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          contractVersion: '2.0.0',
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.deep.include({
      contractVersion: { actual: '1.0.0', expected: '2.0.0' },
    });
  });

  it('flags a crossCollateralRouters enrollment drift', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters: {
            [test1.name]: ['0x' + 'a'.repeat(64)],
          },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters: {
            [test1.name]: ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64)],
          },
        },
      },
    );

    expect(diff).to.not.deep.equal({});
  });
});

describe('buildWarpRouteDiff', () => {
  const CHAIN = test1.name;
  const REAL_HOOK = '0x1111111111111111111111111111111111111111';

  function onChainConfig(hook: string): DerivedWarpRouteDeployConfig {
    return {
      [CHAIN]: {
        destinationGas: {},
        hook,
        interchainSecurityModule: MAILBOX,
        mailbox: MAILBOX,
        owner: OWNER,
        remoteRouters: {},
        token: TOKEN_A,
        type: TokenType.collateral,
      },
    };
  }

  function expectedConfig(): WarpRouteDeployConfigMailboxRequired {
    return {
      [CHAIN]: {
        destinationGas: {},
        interchainSecurityModule: MAILBOX,
        mailbox: MAILBOX,
        owner: OWNER,
        remoteRouters: {},
        token: TOKEN_A,
        type: TokenType.collateral,
      },
    };
  }

  it('treats an on-chain zero-address hook as unset when the deploy config omits it', () => {
    const diff = buildWarpRouteDiff({
      onChainWarpConfig: onChainConfig(zeroAddress),
      warpRouteConfig: expectedConfig(),
    });

    expect(diff).to.deep.equal({});
  });

  it('still flags a genuinely configured (non-zero) on-chain hook when the deploy config omits it', () => {
    const diff = buildWarpRouteDiff({
      onChainWarpConfig: onChainConfig(REAL_HOOK),
      warpRouteConfig: expectedConfig(),
    });

    expect(diff[CHAIN]).to.have.nested.property('hook.actual');
  });
});
