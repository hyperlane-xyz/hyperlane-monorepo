import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  MergedRegistry,
  PartialRegistry,
  type ChainAddresses,
} from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import {
  DEFAULT_ROUTER_KEY,
  type HypTokenRouterConfig,
  type TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';
import { readJson, readYaml } from '@hyperlane-xyz/utils/fs';

import {
  PRODUCTION_APPLY_ARTIFACT_PATHS,
  PRODUCTION_APPLY_ROUTE_ID,
  PRODUCTION_BSC_EXISTING_FEE_ROOT,
  PRODUCTION_BSC_USDT_ROUTER,
  type ProductionApplyManifest,
  buildProductionApplyArtifact,
  emitProductionApplyArtifact,
} from '../scripts/moonpay/build-production-piecewise-apply-config-lib.js';

const OWNER = '0xA0e41Ab972294A8f7CD1599BB76AdDB6bAE24556';
const TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const MAILBOX = '0x1111111111111111111111111111111111111111';
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];
const TARGETS = {
  arbitrum: '0x0000000000000000000000000000000000000011',
  base: '0x0000000000000000000000000000000000000012',
  citrea: '0x0000000000000000000000000000000000000013',
  ethereum: '0x0000000000000000000000000000000000000014',
  katana: '0x0000000000000000000000000000000000000015',
  polygon: '0x0000000000000000000000000000000000000016',
  solanamainnet: 'HW9NfLGo6YMoM6o5auTvn5h26tWJPpsroUDfGFwvsQsU',
} as const;

const DOMAINS = Object.fromEntries(
  Object.keys(TARGETS).map((destination, index) => [
    destination,
    1_000 + index,
  ]),
);

function currentLinear(address: string): TokenFeeConfigInput {
  return {
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner: OWNER,
    bps: 3,
    quoteSigners: QUOTE_SIGNERS,
    address,
    token: TOKEN,
    maxFee: 3n,
    halfAmount: 10_000n,
  } as TokenFeeConfigInput;
}

function desiredPiecewise(): TokenFeeConfigInput {
  return {
    type: TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    owner: OWNER,
    initialFallback: { breakpoints: [], marginalBps: [15] },
    maxBands: 4,
    quoteSigners: QUOTE_SIGNERS,
  };
}

function fixture() {
  const currentFeeContracts: Record<
    string,
    Record<string, TokenFeeConfigInput>
  > = {};
  const desiredFeeContracts: Record<
    string,
    Record<string, TokenFeeConfigInput>
  > = {};
  const oldRootPointers = Object.entries(TARGETS).map(
    ([destination, target], index) => {
      const key = addressToBytes32(target);
      const oldLeaf = `0x${(100 + index).toString(16).padStart(40, '0')}`;
      currentFeeContracts[destination] = {
        [DEFAULT_ROUTER_KEY]: currentLinear(
          `0x${(200 + index).toString(16).padStart(40, '0')}`,
        ),
        [key]: currentLinear(oldLeaf),
      };
      desiredFeeContracts[destination] = {
        [key]: desiredPiecewise(),
      };
      return {
        destination,
        domain: DOMAINS[destination],
        targetRouter: target,
        targetRouterKey: key,
        oldLeaf,
      };
    },
  );
  // A non-target leaf proves the builder preserves unrelated fee topology.
  currentFeeContracts.bsc = {
    [DEFAULT_ROUTER_KEY]: currentLinear(
      '0x0000000000000000000000000000000000000200',
    ),
    [addressToBytes32('0x0000000000000000000000000000000000000030')]:
      currentLinear('0x0000000000000000000000000000000000000201'),
  };

  const currentConfig = {
    type: TokenType.crossCollateral,
    token: TOKEN,
    mailbox: MAILBOX,
    owner: '0x0000000000000000000000000000000000000040',
    hook: '0x0000000000000000000000000000000000000041',
    tokenFee: {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: OWNER,
      feeContracts: currentFeeContracts,
    },
  } as HypTokenRouterConfig;
  const desiredTokenFee = {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner: OWNER,
    feeContracts: desiredFeeContracts,
  } as TokenFeeConfigInput;
  const sourceRoute = {
    tokens: [
      {
        chainName: 'bsc',
        addressOrDenom: PRODUCTION_BSC_USDT_ROUTER,
        standard: 'EvmHypCrossCollateralRouter',
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 18,
        connections: [{ token: 'ethereum|ethereum|0x01' }],
      },
      {
        chainName: 'ethereum',
        addressOrDenom: '0x0000000000000000000000000000000000000050',
        standard: 'EvmHypCrossCollateralRouter',
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 6,
      },
    ],
  } as WarpCoreConfig;
  const usdcRoute = {
    tokens: Object.entries(TARGETS).map(([chainName, addressOrDenom]) => ({
      chainName,
      addressOrDenom,
      standard:
        chainName === 'solanamainnet'
          ? 'SealevelHypCollateral'
          : 'EvmHypCrossCollateralRouter',
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
    })),
  } as WarpCoreConfig;
  const metadata = {
    name: 'bsc',
    chainId: 56,
    domainId: 56,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://bsc.example' }],
    nativeToken: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  };
  const addresses = { mailbox: MAILBOX } as ChainAddresses;
  return {
    currentConfig,
    desiredTokenFee,
    sourceRoute,
    usdcRoute,
    metadata,
    addresses,
    oldRootPointers,
  };
}

function build() {
  const data = fixture();
  return {
    data,
    artifact: buildProductionApplyArtifact({
      ...data,
      sourceBlock: 123_456,
      sourceFeeRoot: PRODUCTION_BSC_EXISTING_FEE_ROOT,
      gitCommit: 'a'.repeat(40),
      domainByDestination: DOMAINS,
    }),
  };
}

describe('Moonpay production piecewise apply-config builder', () => {
  it('overlays exactly seven old linear USDC pointers with flat 15 bps piecewise leaves', () => {
    const { data, artifact } = build();
    const original = data.currentConfig;
    expect(artifact.manifest.overlays).to.deep.equal(data.oldRootPointers);
    expect(artifact.manifest.applyConfigHash).to.match(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.manifest.gitCommit).to.equal('a'.repeat(40));

    const actualFee = artifact.applyConfig.bsc.tokenFee;
    expect(actualFee?.type).to.equal(TokenFeeType.CrossCollateralRoutingFee);
    if (actualFee?.type !== TokenFeeType.CrossCollateralRoutingFee) return;
    for (const pointer of data.oldRootPointers) {
      const leaf =
        actualFee.feeContracts[pointer.destination][pointer.targetRouterKey];
      expect(leaf.type).to.equal(TokenFeeType.OffchainQuotedPiecewiseLinearFee);
      if (leaf.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee) {
        expect('initialFallback' in leaf && leaf.initialFallback).to.deep.equal(
          {
            breakpoints: [],
            marginalBps: [15],
          },
        );
      }
      expect(
        actualFee.feeContracts[pointer.destination][DEFAULT_ROUTER_KEY],
      ).to.equal(
        (
          original.tokenFee as Extract<
            TokenFeeConfigInput,
            { type: typeof TokenFeeType.CrossCollateralRoutingFee }
          >
        ).feeContracts[pointer.destination][DEFAULT_ROUTER_KEY],
      );
    }
    expect(actualFee.feeContracts.bsc).to.equal(
      (
        original.tokenFee as Extract<
          TokenFeeConfigInput,
          { type: typeof TokenFeeType.CrossCollateralRoutingFee }
        >
      ).feeContracts.bsc,
    );
  });

  it('fails closed when any old target is not the expected 3 bps quoted-linear shape', () => {
    const data = fixture();
    const first = data.oldRootPointers[0];
    const currentFee = data.currentConfig.tokenFee as Extract<
      TokenFeeConfigInput,
      { type: typeof TokenFeeType.CrossCollateralRoutingFee }
    >;
    currentFee.feeContracts[first.destination][first.targetRouterKey] =
      desiredPiecewise();
    expect(() =>
      buildProductionApplyArtifact({
        ...data,
        sourceBlock: 1,
        sourceFeeRoot: PRODUCTION_BSC_EXISTING_FEE_ROOT,
        gitCommit: 'b'.repeat(40),
        domainByDestination: DOMAINS,
      }),
    ).to.throw('expected 3 bps OffchainQuotedLinearFee');
  });

  it('emits a BSC-only overlay that must precede the base registry', async () => {
    const { artifact } = build();
    const output = mkdtempSync(path.join(tmpdir(), 'moonpay-apply-'));
    try {
      const files = emitProductionApplyArtifact(output, artifact);
      const manifest = readJson<ProductionApplyManifest>(files.manifest);
      expect(manifest.registryMergeOrder).to.deep.equal([
        'generated-artifact',
        'base-registry',
      ]);
      expect(manifest.requiresBaseRegistry).to.equal(true);
      expect(manifest.artifactScope).to.deep.equal({
        metadataChains: ['bsc'],
        addressChains: ['bsc'],
        applyConfigChains: ['bsc'],
        warpRouteChains: ['bsc'],
      });
      expect(Object.keys(readYaml(files.applyConfig))).to.deep.equal(['bsc']);

      const generated = new FileSystemRegistry({
        uri: path.join(output, 'registry'),
      });
      expect(Object.keys(await generated.getMetadata())).to.deep.equal(['bsc']);
      expect(Object.keys(await generated.getAddresses())).to.deep.equal([
        'bsc',
      ]);
      expect(
        (await generated.getWarpRoute(PRODUCTION_APPLY_ROUTE_ID))?.tokens.map(
          ({ chainName }) => chainName,
        ),
      ).to.deep.equal(['bsc']);

      const ethereumIcaRouter = '0x0000000000000000000000000000000000000e01';
      const base = new PartialRegistry({
        chainMetadata: {
          ethereum: {
            name: 'ethereum',
            chainId: 1,
            domainId: 1,
            protocol: ProtocolType.Ethereum,
            rpcUrls: [{ http: 'http://ethereum.example' }],
          },
        },
        chainAddresses: {
          ethereum: { interchainAccountRouter: ethereumIcaRouter },
        },
      });
      // MergedRegistry returns the first truthy registry result, so the
      // generated BSC route/config overlay must precede the complete registry.
      const merged = new MergedRegistry({ registries: [generated, base] });
      expect((await merged.getMetadata()).ethereum?.chainId).to.equal(1);
      expect(
        (await merged.getAddresses()).ethereum?.interchainAccountRouter,
      ).to.equal(ethereumIcaRouter);
      expect((await merged.getMetadata()).bsc?.chainId).to.equal(56);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('checks in file guards for non-fee transactions in every strategy', () => {
    const strategies = [
      'moonpay-production-piecewise-fork.yaml',
      'moonpay-production-piecewise-ica-file.yaml',
      'moonpay-production-piecewise-live.yaml',
    ].map((filename) =>
      readYaml<Record<string, any>>(
        fileURLToPath(
          new URL(
            `../config/environments/mainnet3/warp/strategies/${filename}`,
            import.meta.url,
          ),
        ),
      ),
    );
    for (const strategy of strategies) {
      expect(Object.keys(strategy)).to.deep.equal(['bsc']);
      expect(strategy.bsc.submitter.type).to.equal('file');
      expect(strategy.bsc.feeSubmitter).not.to.equal(undefined);
    }
    expect(strategies[0].bsc.feeSubmitter.type).to.equal('impersonatedAccount');
    expect(strategies[1].bsc.feeSubmitter.type).to.equal('interchainAccount');
    expect(strategies[1].bsc.feeSubmitter.internalSubmitter.type).to.equal(
      'file',
    );
    expect(strategies[2].bsc.feeSubmitter.internalSubmitter.type).to.equal(
      'gnosisSafe',
    );

    const forkSubmit = readYaml<Record<string, any>>(
      fileURLToPath(
        new URL(
          '../config/environments/mainnet3/warp/strategies/moonpay-production-piecewise-fork-submit.yaml',
          import.meta.url,
        ),
      ),
    );
    expect(forkSubmit).to.deep.equal({
      bsc: {
        submitter: {
          chain: 'bsc',
          type: 'impersonatedAccount',
          userAddress: '0xA0e41Ab972294A8f7CD1599BB76AdDB6bAE24556',
        },
      },
    });
  });

  it('uses the registry-compatible checked-in artifact paths', () => {
    expect(PRODUCTION_APPLY_ARTIFACT_PATHS.warpRoute).to.equal(
      'registry/deployments/warp_routes/USDT/moonpay-config.yaml',
    );
    expect(PRODUCTION_APPLY_ARTIFACT_PATHS.applyConfig).to.equal(
      'registry/deployments/warp_routes/USDT/moonpay-deploy.yaml',
    );
  });
});
