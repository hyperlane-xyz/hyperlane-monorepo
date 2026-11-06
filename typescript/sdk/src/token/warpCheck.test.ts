import type { DerivedCollateralWarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { expect } from 'chai';
import sinon from 'sinon';
import { zeroAddress } from 'viem';

import { CrossCollateralRouter__factory } from '@hyperlane-xyz/core';
import {
  type ObjectDiff,
  ProtocolType,
  addressToBytes32,
  assert,
} from '@hyperlane-xyz/utils';

import {
  test1,
  test2,
  test3,
  testSealevelChain,
  testStarknetChain,
} from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenType } from './config.js';
import { HookType } from '../hook/types.js';
import {
  type DerivedIsmConfig,
  IsmType,
  type LayerZeroV2IsmConfig,
  type WormholeIsmConfig,
} from '../ism/types.js';
import { EvmLayerZeroV2HookIsmModule } from '../layerzero/EvmLayerZeroV2HookIsmModule.js';
import { LayerZeroV2ConfigMode } from '../layerzero/types.js';
import type {
  DerivedLayerZeroV2HookIsmConfig,
  LayerZeroV2MeshConfig,
  LayerZeroV2RemoteRouterConfig,
} from '../layerzero/types.js';
import { EvmWormholeHookIsmModule } from '../wormhole/EvmWormholeHookIsmModule.js';
import {
  WormholeConsistencyLevel,
  WormholeConsistencyType,
} from '../wormhole/consistency.js';
import {
  type DerivedWormholeHookIsmConfig,
  type WormholeMeshConfig,
} from '../wormhole/types.js';
import {
  type DerivedWarpRouteDeployConfig,
  HypTokenConfigSchema,
  OwnerStatus,
  type WarpRouteDeployConfigMailboxRequired,
} from './types.js';
import {
  altVmScaleMismatch,
  applyAcceptedInactiveOwnerStatus,
  buildAltVmWarpRouteDiff,
  buildLayerZeroV2RemoteRouterDiff,
  buildWormholeRemoteRouterDiff,
  buildWarpRouteDiff,
  checkWarpRouteDeployConfig,
  deriveLayerZeroV2RemoteRouterDiff,
  deriveWormholeRemoteRouterDiff,
  derivedWarpConfigToCheckConfig,
  expandedDeployConfigToAltVmCheckConfig,
  getScaleViolations,
  mergeChainDiffs,
  normalizeAltVmDestinationGas,
} from './warpCheck.js';

const MAILBOX = '0x000000000000000000000000000000000000b001';
const OWNER = '0x000000000000000000000000000000000000dEaD';
const TIMELOCK = '0x000000000000000000000000000000000000bEEF';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TIMELOCK_CONFIG = {
  delay: 259200,
  roles: {
    executor: OWNER,
    proposer: OWNER,
  },
};

type ScaleValidationParams = Parameters<typeof getScaleViolations>[0];
type ScaleValidationWarpRouteConfig = ScaleValidationParams['warpRouteConfig'];

function buildMultiProvider(): MultiProvider {
  return new MultiProvider({
    [test1.name]: test1,
    [test2.name]: test2,
    [testSealevelChain.name]: testSealevelChain,
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

function nativeDeployConfig(
  chain: string,
  overrides: {
    ownerOverrides?: Record<string, string>;
    timelock?: typeof TIMELOCK_CONFIG;
  } = {},
): WarpRouteDeployConfigMailboxRequired {
  return {
    [chain]: {
      mailbox: MAILBOX,
      owner: OWNER,
      type: TokenType.native,
      ...overrides,
    },
  };
}

function warpCoreConfig({
  chain,
  decimals,
  standard,
}: {
  chain: string;
  decimals: number;
  standard: TokenStandard;
}) {
  return {
    tokens: [
      {
        addressOrDenom: TOKEN_A,
        chainName: chain,
        decimals,
        name: 'Token',
        standard,
        symbol: 'TOKEN',
      },
    ],
  };
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

  it('drops decimals for AltVM native tokens, whose reader side never carries decimals', () => {
    // DerivedNativeWarpConfig has no decimals field, so the actual side omits it
    // for AltVM native tokens (e.g. Aleo AleoHypNative). The expected side must
    // omit it too even when the core config specifies decimals, otherwise it
    // emits a permanent false-positive `decimals` ConfigMismatch.
    const result = expandedDeployConfigToAltVmCheckConfig(
      testSealevelChain.name,
      {
        decimals: 6,
        destinationGas: {},
        mailbox: MAILBOX,
        owner: OWNER,
        type: TokenType.native,
      },
      buildMultiProvider(),
    );

    expect(result).to.not.have.property('decimals');
  });

  it('retains decimals for AltVM collateral tokens, which do carry on-chain decimals', () => {
    const result = expandedDeployConfigToAltVmCheckConfig(
      testSealevelChain.name,
      {
        decimals: 6,
        destinationGas: {},
        mailbox: MAILBOX,
        owner: OWNER,
        token: TOKEN_A,
        type: TokenType.collateral,
      },
      buildMultiProvider(),
    );

    expect(result.decimals).to.equal(6);
  });
});

describe("HypTokenConfigSchema 'collateralDex' normalization", () => {
  it("maps the paradex-only 'collateralDex' annotation to collateral", () => {
    // collateralDex is a registry-only annotation with no SDK TokenType; the leg
    // is a standard collateral router on-chain, so the schema normalizes it to
    // collateral instead of falling through to unknown (which would false-flag a
    // `type` ConfigMismatch against the derived config).
    const parsed = HypTokenConfigSchema.parse({
      type: 'collateralDex',
      token: TOKEN_A,
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(parsed.type).to.equal(TokenType.collateral);
  });

  it('coerces genuinely unknown token types to unknown', () => {
    const parsed = HypTokenConfigSchema.parse({
      type: 'somethingBogus',
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(parsed.type).to.equal(TokenType.unknown);
  });

  it('leaves known token types unchanged', () => {
    const collateral = HypTokenConfigSchema.parse({
      type: TokenType.collateral,
      token: TOKEN_A,
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(collateral.type).to.equal(TokenType.collateral);

    const native = HypTokenConfigSchema.parse({
      type: TokenType.native,
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(native.type).to.equal(TokenType.native);
  });
});

describe('buildAltVmWarpRouteDiff', () => {
  const remoteRouter = addressToBytes32(ROUTER_B);
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

  it('does not flag a decimals drift when the deploy config omits decimals (altVM native)', () => {
    // expandedDeployConfigToAltVmCheckConfig omits decimals for altVM native
    // tokens, but the Sealevel reader resolves a concrete value (SOL = 9).
    // Comparing 9 against an omitted expected would report a false-positive
    // decimals mismatch on every Sealevel native leg.
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          type: TokenType.native,
          decimals: 9,
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          type: TokenType.native,
        },
      },
    );

    expect(diff).to.deep.equal({});
  });

  it('flags a decimals mismatch when the deploy config opts in', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          decimals: 9,
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          decimals: 6,
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.deep.include({
      decimals: { actual: 9, expected: 6 },
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

  it('does not flag on-chain destinationGas for an unenrolled domain', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
        },
      },
      { [testSealevelChain.name]: { ...baseConfig } },
    );

    expect(diff).to.deep.equal({});
  });

  it('flags destinationGas drift for an enrolled domain', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '5000000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.deep.include({
      destinationGas: {
        [test1.name]: { actual: '64000', expected: '5000000' },
      },
    });
  });

  it('keeps destinationGas for a domain enrolled only through crossCollateralRouters', () => {
    const crossCollateralRouters = {
      [test1.name]: [remoteRouter],
    };
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters,
          destinationGas: { [test1.name]: '64000' },
          type: TokenType.crossCollateral,
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters,
          destinationGas: { [test1.name]: '5000000' },
          type: TokenType.crossCollateral,
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.deep.include({
      destinationGas: {
        [test1.name]: { actual: '64000', expected: '5000000' },
      },
    });
  });

  it('does not flag self-domain crossCollateralRouters destinationGas', () => {
    const crossCollateralRouters = {
      [testSealevelChain.name]: [remoteRouter],
    };
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters,
          destinationGas: { [testSealevelChain.name]: '64000' },
          type: TokenType.crossCollateral,
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          crossCollateralRouters,
          type: TokenType.crossCollateral,
        },
      },
    );

    expect(diff).to.deep.equal({});
  });

  it('does not flag stale gas for an unenrolled domain in a mixed destinationGas map', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: {
            [test1.name]: '64000',
            [test2.name]: '5000000',
          },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
    );

    expect(diff).to.deep.equal({});
  });

  it('does not flag destinationGas as missing when the expected router is missing on-chain but gas is present', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.have.property('remoteRouters');
    expect(diff[testSealevelChain.name]).to.not.have.nested.property(
      `destinationGas.${test1.name}.actual`,
    );
    expect(diff[testSealevelChain.name]).to.not.have.nested.property(
      `destinationGas.${test1.name}.expected`,
    );
  });

  it('flags a zero-vs-nonzero destinationGas drift on an IGP-capable altVM origin (not scoped as no-IGP)', () => {
    // Sealevel consumes destination_gas, so an on-chain 0 against a non-zero
    // expected is a real regression that must NOT be suppressed.
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '0' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
    );

    expect(diff[testSealevelChain.name]).to.deep.include({
      destinationGas: {
        [test1.name]: { actual: '0', expected: '64000' },
      },
    });
  });

  it('does not flag a zero on-chain destinationGas on a no-IGP origin', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testStarknetChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '0' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testStarknetChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      new Set([testStarknetChain.name]),
    );

    expect(diff).to.deep.equal({});
  });

  it('flags a non-zero destinationGas mismatch even on a no-IGP origin', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testStarknetChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '5000000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testStarknetChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '64000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      new Set([testStarknetChain.name]),
    );

    expect(diff[testStarknetChain.name]).to.deep.include({
      destinationGas: {
        [test1.name]: { actual: '5000000', expected: '64000' },
      },
    });
  });

  it('does not flag a matching non-zero destinationGas', () => {
    const diff = buildAltVmWarpRouteDiff(
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '5000000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
      {
        [testSealevelChain.name]: {
          ...baseConfig,
          destinationGas: { [test1.name]: '5000000' },
          remoteRouters: { [test1.name]: remoteRouter },
        },
      },
    );

    expect(diff).to.deep.equal({});
  });
});

describe('normalizeAltVmDestinationGas', () => {
  it('drops destinations whose on-chain gas is 0 from both sides', () => {
    const { actual, expected } = normalizeAltVmDestinationGas(
      { starknet: '0' },
      { starknet: '64000' },
    );

    expect(actual).to.deep.equal({});
    expect(expected).to.deep.equal({});
  });

  it('retains destinations with a non-zero on-chain gas', () => {
    const { actual, expected } = normalizeAltVmDestinationGas(
      { starknet: '5000000' },
      { starknet: '64000' },
    );

    expect(actual).to.deep.equal({ starknet: '5000000' });
    expect(expected).to.deep.equal({ starknet: '64000' });
  });

  it('normalizes a mix of zero and non-zero on-chain gas independently', () => {
    const { actual, expected } = normalizeAltVmDestinationGas(
      { starknet: '0', arbitrum: '5000000' },
      { starknet: '64000', arbitrum: '5000000' },
    );

    expect(actual).to.deep.equal({ arbitrum: '5000000' });
    expect(expected).to.deep.equal({ arbitrum: '5000000' });
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

  it('accepts a derived Wormhole ISM nested in an aggregation', () => {
    const wormholeIsm: WormholeIsmConfig = {
      type: IsmType.WORMHOLE,
      owner: OWNER,
      core: TOKEN_A,
      wormholeChainId: 2,
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      urls: ['https://vaa.example/v1'],
    };
    const derivedTestIsm: DerivedIsmConfig = {
      address: MAILBOX,
      type: IsmType.TEST_ISM,
    };
    const derivedWormholeIsm = {
      address: TOKEN_A,
      type: IsmType.WORMHOLE,
      owner: OWNER,
      core: TOKEN_A,
      wormholeChainId: 2,
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      urls: ['https://vaa.example/v1'],
      remoteRouters: {
        [test2.name]: {
          router: REAL_HOOK,
          wormholeChainId: 30,
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
      },
    };
    const expected = expectedConfig();
    expected[CHAIN].interchainSecurityModule = {
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [{ type: IsmType.TEST_ISM }, wormholeIsm],
    };
    const actual = onChainConfig(zeroAddress);
    actual[CHAIN].interchainSecurityModule = {
      address: REAL_HOOK,
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [derivedTestIsm, derivedWormholeIsm],
    };

    const diff = buildWarpRouteDiff({
      onChainWarpConfig: actual,
      warpRouteConfig: expected,
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

  it('treats the actual ProxyAdmin owner as expected when timelock config is present', () => {
    const actual = onChainConfig(zeroAddress);
    actual[CHAIN].proxyAdmin = {
      address: '0x3333333333333333333333333333333333333333',
      owner: TIMELOCK,
    };
    const expected = expectedConfig();
    expected[CHAIN].proxyAdmin = { owner: OWNER };
    expected[CHAIN].timelock = TIMELOCK_CONFIG;

    const diff = buildWarpRouteDiff({
      onChainWarpConfig: actual,
      warpRouteConfig: expected,
    });

    expect(diff).to.deep.equal({});
  });
});

describe('checkWarpRouteDeployConfig', () => {
  it('rejects timelock config on Alt-VM chains', async () => {
    const chain = testSealevelChain.name;
    const warpDeployConfig = nativeDeployConfig(chain, {
      timelock: TIMELOCK_CONFIG,
    });

    try {
      await checkWarpRouteDeployConfig({
        multiProvider: buildMultiProvider(),
        warpCoreConfig: warpCoreConfig({
          chain,
          decimals: 9,
          standard: TokenStandard.SealevelHypNative,
        }),
        warpDeployConfig,
      });
      expect.fail('expected Alt-VM timelock config to reject');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.equal(
        "Timelock config is not supported on Alt-VM chain 'testsealevel'.",
      );
    }
  });

  it('rejects timelock with ownerOverrides.proxyAdmin at the public check boundary', async () => {
    const chain = test1.name;
    const warpDeployConfig = nativeDeployConfig(chain, {
      ownerOverrides: { proxyAdmin: OWNER },
      timelock: TIMELOCK_CONFIG,
    });

    try {
      await checkWarpRouteDeployConfig({
        multiProvider: buildMultiProvider(),
        warpCoreConfig: warpCoreConfig({
          chain,
          decimals: 18,
          standard: TokenStandard.EvmHypNative,
        }),
        warpDeployConfig,
      });
      expect.fail('expected timelock plus ownerOverrides.proxyAdmin to reject');
    } catch (error) {
      expect(errorMessage(error)).to.include(
        'Cannot configure timelock with ownerOverrides.proxyAdmin',
      );
    }
  });
});

describe('applyAcceptedInactiveOwnerStatus', () => {
  const CHAIN = 'tron';
  const OWNER_A = '0xAAAAaaAAAAaAaaAAAaAAAAaaaAAAaaAAAAaAaAaA';
  const OWNER_B = '0xBbBBBbbBBBbBBBBbbBbBbbBbbbBBbbBBbBBBbBBB';

  // The expander maps every observed ownerStatus to an expected Active, so the
  // expected side starts fully Active; accepting re-sets specific entries back
  // to Inactive.
  function expandedConfig(
    ownerStatus: Record<string, OwnerStatus>,
  ): WarpRouteDeployConfigMailboxRequired {
    return {
      [CHAIN]: {
        mailbox: MAILBOX,
        owner: OWNER_A,
        token: TOKEN_A,
        type: TokenType.collateral,
        ownerStatus,
      },
    };
  }

  it('accepts multiple Inactive owners on the same chain', () => {
    const expanded = expandedConfig({
      [OWNER_A]: OwnerStatus.Active,
      [OWNER_B]: OwnerStatus.Active,
    });

    applyAcceptedInactiveOwnerStatus({
      expandedWarpDeployConfig: expanded,
      onChainWarpConfig: {
        [CHAIN]: {
          ownerStatus: {
            [OWNER_A]: OwnerStatus.Inactive,
            [OWNER_B]: OwnerStatus.Inactive,
          },
        },
      },
      acceptedInactiveOwners: [
        { chain: CHAIN, owner: OWNER_A },
        { chain: CHAIN, owner: OWNER_B },
      ],
    });

    expect(expanded[CHAIN].ownerStatus).to.deep.equal({
      [OWNER_A]: OwnerStatus.Inactive,
      [OWNER_B]: OwnerStatus.Inactive,
    });
  });

  it('does not accept an owner declared on a different chain or with a different address', () => {
    const expanded = expandedConfig({
      [OWNER_A]: OwnerStatus.Active,
    });

    applyAcceptedInactiveOwnerStatus({
      expandedWarpDeployConfig: expanded,
      onChainWarpConfig: {
        [CHAIN]: { ownerStatus: { [OWNER_A]: OwnerStatus.Inactive } },
      },
      acceptedInactiveOwners: [
        // Wrong chain.
        { chain: 'ethereum', owner: OWNER_A },
        // Wrong address on the right chain.
        { chain: CHAIN, owner: OWNER_B },
      ],
    });

    expect(expanded[CHAIN].ownerStatus?.[OWNER_A]).to.equal(OwnerStatus.Active);
  });

  it('does not override non-Inactive observed statuses even when accepted', () => {
    const expanded = expandedConfig({
      [OWNER_A]: OwnerStatus.Active,
      [OWNER_B]: OwnerStatus.GnosisSafe,
    });

    applyAcceptedInactiveOwnerStatus({
      expandedWarpDeployConfig: expanded,
      onChainWarpConfig: {
        [CHAIN]: {
          ownerStatus: {
            [OWNER_A]: OwnerStatus.Active,
            [OWNER_B]: OwnerStatus.GnosisSafe,
          },
        },
      },
      acceptedInactiveOwners: [
        { chain: CHAIN, owner: OWNER_A },
        { chain: CHAIN, owner: OWNER_B },
      ],
    });

    expect(expanded[CHAIN].ownerStatus).to.deep.equal({
      [OWNER_A]: OwnerStatus.Active,
      [OWNER_B]: OwnerStatus.GnosisSafe,
    });
  });

  it('matches owner addresses case-insensitively', () => {
    const expanded = expandedConfig({
      [OWNER_A]: OwnerStatus.Active,
    });

    applyAcceptedInactiveOwnerStatus({
      expandedWarpDeployConfig: expanded,
      onChainWarpConfig: {
        [CHAIN]: { ownerStatus: { [OWNER_A]: OwnerStatus.Inactive } },
      },
      acceptedInactiveOwners: [{ chain: CHAIN, owner: OWNER_A.toLowerCase() }],
    });

    expect(expanded[CHAIN].ownerStatus?.[OWNER_A]).to.equal(
      OwnerStatus.Inactive,
    );
  });

  it('is a no-op when no accepted owners are provided', () => {
    const expanded = expandedConfig({ [OWNER_A]: OwnerStatus.Active });

    applyAcceptedInactiveOwnerStatus({
      expandedWarpDeployConfig: expanded,
      onChainWarpConfig: {
        [CHAIN]: { ownerStatus: { [OWNER_A]: OwnerStatus.Inactive } },
      },
      acceptedInactiveOwners: [],
    });

    expect(expanded[CHAIN].ownerStatus?.[OWNER_A]).to.equal(OwnerStatus.Active);
  });
});

describe('buildWormholeRemoteRouterDiff', () => {
  const CHAIN_A = test1.name;
  const CHAIN_B = test2.name;
  const ROUTER_A = '0x1111111111111111111111111111111111111111';
  const ROUTER_B = '0x2222222222222222222222222222222222222222';
  const CORE_A = '0x3333333333333333333333333333333333333333';
  const CORE_B = '0x4444444444444444444444444444444444444444';
  const URLS = ['https://vaa.example/v1'];

  function mesh(): WormholeMeshConfig {
    return {
      [CHAIN_A]: {
        owner: OWNER,
        mailbox: MAILBOX,
        core: CORE_A,
        wormholeChainId: 2,
        consistencyLevel: { type: WormholeConsistencyType.Finalized },
        urls: URLS,
        remoteRouters: {
          [CHAIN_B]: {
            router: ROUTER_B,
            wormholeChainId: 30,
            expectedConsistencyLevel: 202,
            expectedCustomBaseConsistencyLevel: 0,
            expectedAdditionalBlocks: 0,
          },
        },
      },
      [CHAIN_B]: {
        owner: OWNER,
        mailbox: MAILBOX,
        core: CORE_B,
        wormholeChainId: 30,
        consistencyLevel: { type: WormholeConsistencyType.Finalized },
        urls: URLS,
        remoteRouters: {
          [CHAIN_A]: {
            router: ROUTER_A,
            wormholeChainId: 2,
            expectedConsistencyLevel: 202,
            expectedCustomBaseConsistencyLevel: 0,
            expectedAdditionalBlocks: 0,
          },
        },
      },
    };
  }

  function derived(
    config: WormholeMeshConfig,
  ): Record<string, DerivedWormholeHookIsmConfig> {
    return Object.fromEntries(
      Object.entries(config).map(([chain, chainConfig]) => {
        assert(
          chainConfig.wormholeChainId !== undefined,
          `Missing Wormhole chain ID for ${chain}`,
        );
        return [
          chain,
          {
            ...chainConfig,
            wormholeChainId: chainConfig.wormholeChainId,
            address: chain === CHAIN_A ? ROUTER_A : ROUTER_B,
          },
        ];
      }),
    );
  }

  it('accepts an exact remote-router trust mesh', () => {
    const expected = mesh();
    expect(
      buildWormholeRemoteRouterDiff(derived(expected), expected),
    ).to.deep.equal({});
  });

  it('reports remote router, Wormhole ID, and consistency drift', () => {
    const expected = mesh();
    const actual = derived(mesh());
    actual[CHAIN_A].remoteRouters[CHAIN_B] = {
      router: ROUTER_A,
      wormholeChainId: 31,
      expectedConsistencyLevel: 203,
      expectedCustomBaseConsistencyLevel: 201,
      expectedAdditionalBlocks: 4,
    };

    const diff = buildWormholeRemoteRouterDiff(actual, expected);
    expect(diff[CHAIN_A]).to.have.nested.property(
      `wormholeRemoteRouters.${CHAIN_B}.router.actual`,
      ROUTER_A.toLowerCase(),
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `wormholeRemoteRouters.${CHAIN_B}.wormholeChainId.actual`,
      31,
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `wormholeRemoteRouters.${CHAIN_B}.expectedConsistencyLevel.actual`,
      203,
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `wormholeRemoteRouters.${CHAIN_B}.expectedCustomBaseConsistencyLevel.actual`,
      201,
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `wormholeRemoteRouters.${CHAIN_B}.expectedAdditionalBlocks.actual`,
      4,
    );
  });

  it('reports unexpected enrolled domains', () => {
    const expected = mesh();
    const actual = derived(mesh());
    actual[CHAIN_A].remoteRouters['999999'] = {
      router: ROUTER_A,
      wormholeChainId: 77,
      expectedConsistencyLevel: 202,
      expectedCustomBaseConsistencyLevel: 0,
      expectedAdditionalBlocks: 0,
    };

    expect(buildWormholeRemoteRouterDiff(actual, expected)[CHAIN_A])
      .to.have.nested.property('wormholeRemoteRouters.999999.actual')
      .that.deep.equals({
        router: ROUTER_A.toLowerCase(),
        wormholeChainId: 77,
        expectedConsistencyLevel: 202,
        expectedCustomBaseConsistencyLevel: 0,
        expectedAdditionalBlocks: 0,
      });
  });
});

describe('buildLayerZeroV2RemoteRouterDiff', () => {
  const CHAIN_A = test1.name;
  const CHAIN_B = test2.name;
  const ROUTER_A = '0x1111111111111111111111111111111111111111';
  const ROUTER_B = '0x2222222222222222222222222222222222222222';
  const ENDPOINT = '0x3333333333333333333333333333333333333333';
  const SEND_LIBRARY = '0x5555555555555555555555555555555555555555';
  const RECEIVE_LIBRARY = '0x6666666666666666666666666666666666666666';
  const URLS = ['https://packets.example/layerzero'];

  function route(
    router: string,
    layerZeroDomainId: number,
  ): LayerZeroV2RemoteRouterConfig {
    return {
      router,
      layerZeroDomainId,
      sendLibrary: SEND_LIBRARY,
      receiveLibrary: RECEIVE_LIBRARY,
      sendConfig: {
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      },
      receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
    };
  }

  function mesh(): LayerZeroV2MeshConfig {
    return {
      [CHAIN_A]: {
        owner: OWNER,
        mailbox: MAILBOX,
        endpoint: ENDPOINT,
        layerZeroDomainId: 30_101,
        urls: URLS,
        remoteRouters: { [CHAIN_B]: route(ROUTER_B, 30_102) },
      },
      [CHAIN_B]: {
        owner: OWNER,
        mailbox: MAILBOX,
        endpoint: ENDPOINT,
        layerZeroDomainId: 30_102,
        urls: URLS,
        remoteRouters: { [CHAIN_A]: route(ROUTER_A, 30_101) },
      },
    };
  }

  function derived(): Record<string, DerivedLayerZeroV2HookIsmConfig> {
    const { [CHAIN_A]: a, [CHAIN_B]: b } = mesh();
    assert(a.layerZeroDomainId !== undefined, 'Missing chain A domain ID');
    assert(b.layerZeroDomainId !== undefined, 'Missing chain B domain ID');
    return {
      [CHAIN_A]: {
        address: ROUTER_A,
        owner: a.owner,
        mailbox: a.mailbox,
        endpoint: a.endpoint,
        layerZeroDomainId: a.layerZeroDomainId,
        urls: a.urls,
        remoteRouters: a.remoteRouters,
      },
      [CHAIN_B]: {
        address: ROUTER_B,
        owner: b.owner,
        mailbox: b.mailbox,
        endpoint: b.endpoint,
        layerZeroDomainId: b.layerZeroDomainId,
        urls: b.urls,
        remoteRouters: b.remoteRouters,
      },
    };
  }

  it('accepts an exact reciprocal peer mesh', () => {
    expect(buildLayerZeroV2RemoteRouterDiff(derived(), mesh())).to.deep.equal(
      {},
    );
  });

  it('reports a changed enrolled peer and endpoint ID', () => {
    const actual = derived();
    actual[CHAIN_A].remoteRouters[CHAIN_B] = route(ROUTER_A, 30_999);

    const diff = buildLayerZeroV2RemoteRouterDiff(actual, mesh());

    expect(diff[CHAIN_A]).to.have.nested.property(
      `layerZeroRemoteRouters.${CHAIN_B}.router.actual`,
      ROUTER_A.toLowerCase(),
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `layerZeroRemoteRouters.${CHAIN_B}.router.expected`,
      ROUTER_B.toLowerCase(),
    );
    expect(diff[CHAIN_A]).to.have.nested.property(
      `layerZeroRemoteRouters.${CHAIN_B}.layerZeroDomainId.actual`,
      30_999,
    );
    expect(diff).not.to.have.property(CHAIN_B);
  });

  it('leaves pathway policy to the ISM diff', () => {
    const actual = derived();
    const changedPolicy = route(ROUTER_B, 30_102);
    changedPolicy.sendLibrary = RECEIVE_LIBRARY;
    actual[CHAIN_A].remoteRouters[CHAIN_B] = changedPolicy;

    expect(buildLayerZeroV2RemoteRouterDiff(actual, mesh())).to.deep.equal({});
  });

  it('skips enrollments of unresolved chains', () => {
    const expected = mesh();
    delete expected[CHAIN_A].remoteRouters[CHAIN_B];
    const actual = derived();
    actual[CHAIN_A].remoteRouters[CHAIN_B] = route(ROUTER_A, 30_102);

    expect(
      buildLayerZeroV2RemoteRouterDiff(actual, expected, [CHAIN_B]),
    ).to.deep.equal({});
  });
});

describe('deriveWormholeRemoteRouterDiff', () => {
  const CHAINS = [test1.name, test2.name, test3.name];
  const ROUTERS: Record<string, string> = {
    [test1.name]: '0x1111111111111111111111111111111111111111',
    [test2.name]: '0x2222222222222222222222222222222222222222',
    [test3.name]: '0x3333333333333333333333333333333333333333',
  };
  const WORMHOLE_CHAIN_IDS: Record<string, number> = {
    [test1.name]: 2,
    [test2.name]: 30,
    [test3.name]: 23,
  };
  const CORE = '0x4444444444444444444444444444444444444444';
  const OTHER = '0x5555555555555555555555555555555555555555';
  const URLS = ['https://vaa.example/v1'];

  interface Surfaces {
    hook: string;
    ism?: string;
  }

  function deployConfig(
    chains: string[],
  ): WarpRouteDeployConfigMailboxRequired {
    return Object.fromEntries(
      chains.map((chain) => [
        chain,
        {
          type: TokenType.synthetic,
          mailbox: MAILBOX,
          owner: OWNER,
          hook: { type: HookType.WORMHOLE },
          interchainSecurityModule: {
            type: IsmType.WORMHOLE,
            owner: OWNER,
            core: CORE,
            wormholeChainId: WORMHOLE_CHAIN_IDS[chain],
            consistencyLevel: { type: WormholeConsistencyType.Finalized },
            urls: URLS,
          },
        },
      ]),
    );
  }

  function onChainConfig(
    surfaces: Record<string, Surfaces>,
  ): DerivedWarpRouteDeployConfig {
    return Object.fromEntries(
      Object.entries(surfaces).map(([chain, { hook, ism }]) => [
        chain,
        {
          type: TokenType.synthetic,
          mailbox: MAILBOX,
          owner: OWNER,
          destinationGas: {},
          remoteRouters: {},
          hook: { address: hook, type: HookType.WORMHOLE },
          interchainSecurityModule: ism
            ? {
                address: ism,
                type: IsmType.WORMHOLE,
                owner: OWNER,
                core: CORE,
                wormholeChainId: WORMHOLE_CHAIN_IDS[chain],
                consistencyLevel: { type: WormholeConsistencyType.Finalized },
                urls: URLS,
              }
            : { address: OTHER, type: IsmType.TEST_ISM },
        },
      ]),
    );
  }

  function derivedRouter(
    chain: string,
    chains: string[],
  ): DerivedWormholeHookIsmConfig {
    return {
      address: ROUTERS[chain],
      owner: OWNER,
      mailbox: MAILBOX,
      core: CORE,
      wormholeChainId: WORMHOLE_CHAIN_IDS[chain],
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      urls: URLS,
      remoteRouters: Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => [
            remote,
            {
              router: ROUTERS[remote],
              wormholeChainId: WORMHOLE_CHAIN_IDS[remote],
              expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
              expectedCustomBaseConsistencyLevel: 0,
              expectedAdditionalBlocks: 0,
            },
          ]),
      ),
    };
  }

  let readMesh: sinon.SinonStub;
  let routers: Record<string, DerivedWormholeHookIsmConfig>;

  function deployRouters(chains: string[]): void {
    routers = Object.fromEntries(
      chains.map((chain) => [chain, derivedRouter(chain, chains)]),
    );
  }

  beforeEach(() => {
    readMesh = sinon
      .stub(EvmWormholeHookIsmModule, 'readMesh')
      .callsFake(async (_multiProvider, addresses) =>
        Object.fromEntries(
          Object.keys(addresses).map((chain) => [chain, routers[chain]]),
        ),
      );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('reports a chain whose hook and ISM are different instances', async () => {
    const chains = [test1.name, test2.name];
    deployRouters(chains);

    const diff = await deriveWormholeRemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig({
        [test1.name]: { hook: ROUTERS[test1.name], ism: ROUTERS[test1.name] },
        [test2.name]: { hook: OTHER, ism: ROUTERS[test2.name] },
      }),
      warpDeployConfig: deployConfig(chains),
    });

    expect(diff).to.deep.equal({
      [test2.name]: {
        combinedHookIsm: {
          [IsmType.WORMHOLE]: {
            hook: { expected: ROUTERS[test2.name], actual: OTHER },
          },
        },
      },
    });
    expect(readMesh.firstCall.args[1]).to.deep.equal({
      [test1.name]: ROUTERS[test1.name],
    });
  });

  it('reports a chain with no combined ISM', async () => {
    const chains = [test1.name, test2.name];
    deployRouters(chains);

    const diff = await deriveWormholeRemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig({
        [test1.name]: { hook: ROUTERS[test1.name], ism: ROUTERS[test1.name] },
        [test2.name]: { hook: ROUTERS[test2.name] },
      }),
      warpDeployConfig: deployConfig(chains),
    });

    expect(diff).to.deep.equal({
      [test2.name]: {
        combinedHookIsm: {
          [IsmType.WORMHOLE]: {
            interchainSecurityModule: {
              expected: 'one instance',
              actual: 'missing',
            },
          },
        },
      },
    });
  });

  it('still reports enrollment drift on a resolved chain when another chain is split', async () => {
    deployRouters(CHAINS);
    routers[test1.name].remoteRouters[test2.name].wormholeChainId = 31;

    const diff = await deriveWormholeRemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig({
        [test1.name]: { hook: ROUTERS[test1.name], ism: ROUTERS[test1.name] },
        [test2.name]: { hook: ROUTERS[test2.name], ism: ROUTERS[test2.name] },
        [test3.name]: { hook: OTHER, ism: ROUTERS[test3.name] },
      }),
      warpDeployConfig: deployConfig(CHAINS),
    });

    expect(diff[test3.name]).to.deep.equal({
      combinedHookIsm: {
        [IsmType.WORMHOLE]: {
          hook: { expected: ROUTERS[test3.name], actual: OTHER },
        },
      },
    });
    expect(diff[test1.name]).to.deep.equal({
      wormholeRemoteRouters: {
        [test2.name]: {
          router: ROUTERS[test2.name],
          wormholeChainId: { actual: 31, expected: 30 },
          expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
      },
    });
    expect(diff).to.not.have.property(test2.name);
  });
});

describe('deriveLayerZeroV2RemoteRouterDiff', () => {
  const CHAINS = [test1.name, test2.name, test3.name];
  const ROUTERS: Record<string, string> = {
    [test1.name]: '0x1111111111111111111111111111111111111111',
    [test2.name]: '0x2222222222222222222222222222222222222222',
    [test3.name]: '0x3333333333333333333333333333333333333333',
  };
  const LAYER_ZERO_DOMAIN_IDS: Record<string, number> = {
    [test1.name]: 30_101,
    [test2.name]: 30_102,
    [test3.name]: 30_103,
  };
  const ENDPOINT = '0x4444444444444444444444444444444444444444';
  const LIBRARY = '0x5555555555555555555555555555555555555555';
  const OTHER = '0x6666666666666666666666666666666666666666';
  const URLS = ['https://packets.example/layerzero'];

  interface Surfaces {
    hook: string;
    ism?: string;
  }

  function route(
    router: string,
    remote: string,
  ): LayerZeroV2RemoteRouterConfig {
    return {
      router,
      layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[remote],
      sendLibrary: LIBRARY,
      receiveLibrary: LIBRARY,
      sendConfig: {
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      },
      receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
    };
  }

  function pathways(
    chain: string,
    chains: string[],
  ): LayerZeroV2IsmConfig['pathways'] {
    return Object.fromEntries(
      chains
        .filter((remote) => remote !== chain)
        .map((remote) => [
          remote,
          {
            layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[remote],
            sendLibrary: LIBRARY,
            receiveLibrary: LIBRARY,
            sendConfig: {
              executor: { type: LayerZeroV2ConfigMode.Default },
              uln: { type: LayerZeroV2ConfigMode.Default },
            },
            receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
          },
        ]),
    );
  }

  function deployConfig(
    chains: string[],
  ): WarpRouteDeployConfigMailboxRequired {
    return Object.fromEntries(
      chains.map((chain) => [
        chain,
        {
          type: TokenType.synthetic,
          mailbox: MAILBOX,
          owner: OWNER,
          hook: { type: HookType.LAYER_ZERO_V2 },
          interchainSecurityModule: {
            type: IsmType.LAYER_ZERO_V2,
            owner: OWNER,
            endpoint: ENDPOINT,
            layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[chain],
            urls: URLS,
            pathways: pathways(chain, chains),
          },
        },
      ]),
    );
  }

  function onChainConfig(
    chains: string[],
    surfaces: Record<string, Surfaces>,
  ): DerivedWarpRouteDeployConfig {
    return Object.fromEntries(
      Object.entries(surfaces).map(([chain, { hook, ism }]) => [
        chain,
        {
          type: TokenType.synthetic,
          mailbox: MAILBOX,
          owner: OWNER,
          destinationGas: {},
          remoteRouters: {},
          hook: { address: hook, type: HookType.LAYER_ZERO_V2 },
          interchainSecurityModule: ism
            ? {
                address: ism,
                type: IsmType.LAYER_ZERO_V2,
                owner: OWNER,
                endpoint: ENDPOINT,
                layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[chain],
                urls: URLS,
                pathways: pathways(chain, chains),
              }
            : { address: OTHER, type: IsmType.TEST_ISM },
        },
      ]),
    );
  }

  function combined(chain: string): Surfaces {
    return { hook: ROUTERS[chain], ism: ROUTERS[chain] };
  }

  function derivedRouter(
    chain: string,
    chains: string[],
  ): DerivedLayerZeroV2HookIsmConfig {
    return {
      address: ROUTERS[chain],
      owner: OWNER,
      mailbox: MAILBOX,
      endpoint: ENDPOINT,
      layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[chain],
      urls: URLS,
      remoteRouters: Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => [remote, route(ROUTERS[remote], remote)]),
      ),
    };
  }

  let readMesh: sinon.SinonStub;
  let routers: Record<string, DerivedLayerZeroV2HookIsmConfig>;

  function deployRouters(chains: string[]): void {
    routers = Object.fromEntries(
      chains.map((chain) => [chain, derivedRouter(chain, chains)]),
    );
  }

  beforeEach(() => {
    readMesh = sinon
      .stub(EvmLayerZeroV2HookIsmModule, 'readMesh')
      .callsFake(async (_multiProvider, addresses) =>
        Object.fromEntries(
          Object.keys(addresses).map((chain) => [chain, routers[chain]]),
        ),
      );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('accepts a mesh whose enrolled peers match the deployed routers', async () => {
    deployRouters(CHAINS);

    const diff = await deriveLayerZeroV2RemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig(CHAINS, {
        [test1.name]: combined(test1.name),
        [test2.name]: combined(test2.name),
        [test3.name]: combined(test3.name),
      }),
      warpDeployConfig: deployConfig(CHAINS),
    });

    expect(diff).to.deep.equal({});
    expect(readMesh.firstCall.args[1]).to.deep.equal(ROUTERS);
  });

  it('reports a wrong enrolled peer', async () => {
    const chains = [test1.name, test2.name];
    deployRouters(chains);
    routers[test1.name].remoteRouters[test2.name].router = OTHER;

    const diff = await deriveLayerZeroV2RemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig(chains, {
        [test1.name]: combined(test1.name),
        [test2.name]: combined(test2.name),
      }),
      warpDeployConfig: deployConfig(chains),
    });

    expect(diff).to.deep.equal({
      [test1.name]: {
        layerZeroRemoteRouters: {
          [test2.name]: {
            router: { actual: OTHER, expected: ROUTERS[test2.name] },
            layerZeroDomainId: 30_102,
          },
        },
      },
    });
  });

  it('reports a chain whose hook and ISM are different instances', async () => {
    const chains = [test1.name, test2.name];
    deployRouters(chains);

    const diff = await deriveLayerZeroV2RemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig(chains, {
        [test1.name]: combined(test1.name),
        [test2.name]: { hook: OTHER, ism: ROUTERS[test2.name] },
      }),
      warpDeployConfig: deployConfig(chains),
    });

    expect(diff).to.deep.equal({
      [test2.name]: {
        combinedHookIsm: {
          [IsmType.LAYER_ZERO_V2]: {
            hook: { expected: ROUTERS[test2.name], actual: OTHER },
          },
        },
      },
    });
    expect(readMesh.firstCall.args[1]).to.deep.equal({
      [test1.name]: ROUTERS[test1.name],
    });
  });

  it('reports a chain with no combined ISM', async () => {
    const chains = [test1.name, test2.name];
    deployRouters(chains);

    const diff = await deriveLayerZeroV2RemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig(chains, {
        [test1.name]: combined(test1.name),
        [test2.name]: { hook: ROUTERS[test2.name] },
      }),
      warpDeployConfig: deployConfig(chains),
    });

    expect(diff).to.deep.equal({
      [test2.name]: {
        combinedHookIsm: {
          [IsmType.LAYER_ZERO_V2]: {
            interchainSecurityModule: {
              expected: 'one instance',
              actual: 'missing',
            },
          },
        },
      },
    });
  });

  it('skips enrollments of an unresolved chain', async () => {
    deployRouters(CHAINS);
    routers[test1.name].remoteRouters[test3.name].router = OTHER;

    const diff = await deriveLayerZeroV2RemoteRouterDiff({
      multiProvider: MultiProvider.createTestMultiProvider(),
      onChainWarpConfig: onChainConfig(CHAINS, {
        [test1.name]: combined(test1.name),
        [test2.name]: combined(test2.name),
        [test3.name]: { hook: OTHER, ism: ROUTERS[test3.name] },
      }),
      warpDeployConfig: deployConfig(CHAINS),
    });

    expect(diff).to.deep.equal({
      [test3.name]: {
        combinedHookIsm: {
          [IsmType.LAYER_ZERO_V2]: {
            hook: { expected: ROUTERS[test3.name], actual: OTHER },
          },
        },
      },
    });
    expect(readMesh.firstCall.args[1]).to.deep.equal({
      [test1.name]: ROUTERS[test1.name],
      [test2.name]: ROUTERS[test2.name],
    });
  });
});

describe('mergeChainDiffs', () => {
  const CHAINS = [test1.name, test2.name];
  const WORMHOLE_CHAIN_IDS: Record<string, number> = {
    [test1.name]: 2,
    [test2.name]: 30,
  };
  const LAYER_ZERO_DOMAIN_IDS: Record<string, number> = {
    [test1.name]: 30_101,
    [test2.name]: 30_102,
  };
  const CORE = '0x4444444444444444444444444444444444444444';
  const ENDPOINT = '0x5555555555555555555555555555555555555555';
  const LIBRARY = '0x6666666666666666666666666666666666666666';
  const AGGREGATION = '0x7777777777777777777777777777777777777777';
  const SPLIT_HOOK = '0x8888888888888888888888888888888888888888';
  const WORMHOLE_ISM = '0x9999999999999999999999999999999999999999';
  const LAYER_ZERO_ISM = '0x1212121212121212121212121212121212121212';
  const WORMHOLE_URLS = ['https://vaa.example/v1'];
  const LAYER_ZERO_URLS = ['https://packets.example/layerzero'];

  function wormholeIsm(chain: string): WormholeIsmConfig {
    return {
      type: IsmType.WORMHOLE,
      owner: OWNER,
      core: CORE,
      wormholeChainId: WORMHOLE_CHAIN_IDS[chain],
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      urls: WORMHOLE_URLS,
    };
  }

  function layerZeroIsm(chain: string): LayerZeroV2IsmConfig {
    return {
      type: IsmType.LAYER_ZERO_V2,
      owner: OWNER,
      endpoint: ENDPOINT,
      layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[chain],
      urls: LAYER_ZERO_URLS,
      pathways: Object.fromEntries(
        CHAINS.filter((remote) => remote !== chain).map((remote) => [
          remote,
          {
            layerZeroDomainId: LAYER_ZERO_DOMAIN_IDS[remote],
            sendLibrary: LIBRARY,
            receiveLibrary: LIBRARY,
            sendConfig: {
              executor: { type: LayerZeroV2ConfigMode.Default },
              uln: { type: LayerZeroV2ConfigMode.Default },
            },
            receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
          },
        ]),
      ),
    };
  }

  function deployConfig(): WarpRouteDeployConfigMailboxRequired {
    return Object.fromEntries(
      CHAINS.map((chain) => [
        chain,
        {
          type: TokenType.synthetic,
          mailbox: MAILBOX,
          owner: OWNER,
          hook: {
            type: HookType.AGGREGATION,
            hooks: [
              { type: HookType.WORMHOLE },
              { type: HookType.LAYER_ZERO_V2 },
            ],
          },
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            threshold: 2,
            modules: [wormholeIsm(chain), layerZeroIsm(chain)],
          },
        },
      ]),
    );
  }

  function splitOnChainConfig(): DerivedWarpRouteDeployConfig {
    return Object.fromEntries(
      CHAINS.map((chain) => {
        const wormhole = wormholeIsm(chain);
        const layerZero = layerZeroIsm(chain);
        return [
          chain,
          {
            type: TokenType.synthetic,
            mailbox: MAILBOX,
            owner: OWNER,
            destinationGas: {},
            remoteRouters: {},
            hook: {
              address: AGGREGATION,
              type: HookType.AGGREGATION,
              hooks: [
                { address: SPLIT_HOOK, type: HookType.WORMHOLE },
                { address: SPLIT_HOOK, type: HookType.LAYER_ZERO_V2 },
              ],
            },
            interchainSecurityModule: {
              address: AGGREGATION,
              type: IsmType.AGGREGATION,
              threshold: 2,
              modules: [
                {
                  address: WORMHOLE_ISM,
                  type: wormhole.type,
                  owner: wormhole.owner,
                  core: wormhole.core,
                  wormholeChainId: wormhole.wormholeChainId,
                  consistencyLevel: wormhole.consistencyLevel,
                  urls: wormhole.urls,
                },
                {
                  address: LAYER_ZERO_ISM,
                  type: layerZero.type,
                  owner: layerZero.owner,
                  endpoint: layerZero.endpoint,
                  layerZeroDomainId: layerZero.layerZeroDomainId,
                  urls: layerZero.urls,
                  pathways: layerZero.pathways,
                },
              ],
            },
          },
        ];
      }),
    );
  }

  afterEach(() => {
    sinon.restore();
  });

  it('keeps Wormhole and LayerZero placement problems reported on the same chain', async () => {
    sinon.stub(EvmWormholeHookIsmModule, 'readMesh').resolves({});
    sinon.stub(EvmLayerZeroV2HookIsmModule, 'readMesh').resolves({});
    const multiProvider = MultiProvider.createTestMultiProvider();
    const onChainWarpConfig = splitOnChainConfig();
    const warpDeployConfig = deployConfig();
    const diff: Record<string, ObjectDiff> = {
      [test1.name]: { owner: { expected: OWNER, actual: SPLIT_HOOK } },
    };

    mergeChainDiffs(
      diff,
      await deriveWormholeRemoteRouterDiff({
        multiProvider,
        onChainWarpConfig,
        warpDeployConfig,
      }),
    );
    mergeChainDiffs(
      diff,
      await deriveLayerZeroV2RemoteRouterDiff({
        multiProvider,
        onChainWarpConfig,
        warpDeployConfig,
      }),
    );

    const placement = {
      combinedHookIsm: {
        [IsmType.WORMHOLE]: {
          hook: { expected: WORMHOLE_ISM, actual: SPLIT_HOOK },
        },
        [IsmType.LAYER_ZERO_V2]: {
          hook: { expected: LAYER_ZERO_ISM, actual: SPLIT_HOOK },
        },
      },
    };
    expect(diff).to.deep.equal({
      [test1.name]: {
        owner: { expected: OWNER, actual: SPLIT_HOOK },
        combinedHookIsm: placement.combinedHookIsm,
      },
      [test2.name]: placement,
    });
  });

  it('refuses to overwrite a colliding leaf', () => {
    const diff: Record<string, ObjectDiff> = {
      [test1.name]: { owner: { expected: OWNER, actual: SPLIT_HOOK } },
    };

    expect(() =>
      mergeChainDiffs(diff, {
        [test1.name]: { owner: { expected: OWNER, actual: AGGREGATION } },
      }),
    ).to.throw(
      `Unexpected leaf diff for ${test1.name}.owner; refusing to overwrite it`,
    );
  });
});
