import { address } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { RawNativeWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';

import type { TokenFeeConfig } from '../accounts/token.js';
import { DEFAULT_FEE_SALT, deriveFeeSalt } from '../fee/types.js';
import { deriveFeeAccountPda } from '../pda.js';
import type { SvmRpc } from '../types.js';
import { computeWarpTokenUpdateInstructions } from '../warp/warp-tx.js';

const OWNER = address('zUeFx6cfxedG2JnFtMKkTXnxgPa5M44tyaF9RrPunCp');
const PROGRAM = address('2gqSMt66ZABt82TTQgrdxf7tJ4eQpLuYj6N29ieBQrH2');
const ISM_A = address('11111111111111111111111111111112');
const ISM_B = address('11111111111111111111111111111113');
const NEW_OWNER = address('11111111111111111111111111111114');
const FEE_PROGRAM_A = address('FeeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const FEE_PROGRAM_B = address('FeeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
const ROUTER_HEX =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

/** Stub RPC — returns null for all account lookups (skips upgrade authority). */
function createStubRpc(): SvmRpc {
  return new Proxy(
    {},
    {
      get() {
        return () => ({ send: async () => ({ value: null }) });
      },
    },
  ) as unknown as SvmRpc;
}

function makeConfig(
  overrides: Partial<RawNativeWarpArtifactConfig> = {},
): RawNativeWarpArtifactConfig {
  return {
    type: 'native',
    owner: OWNER,
    remoteRouters: {},
    destinationGas: {},
    ...overrides,
  } as RawNativeWarpArtifactConfig;
}

function deployedIsm(addr: string) {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: { type: 'testIsm' as const },
    deployed: { address: addr },
  };
}

const testCases: {
  name: string;
  current: Partial<RawNativeWarpArtifactConfig>;
  expected: Partial<RawNativeWarpArtifactConfig>;
  expectedTxCount: number;
}[] = [
  {
    name: 'router + gas config enrollment',
    current: {},
    expected: {
      remoteRouters: { 1: { address: ROUTER_HEX } },
      destinationGas: { 1: '100000' },
    },
    expectedTxCount: 2,
  },
  {
    name: 'ISM update',
    current: { interchainSecurityModule: deployedIsm(ISM_A) },
    expected: { interchainSecurityModule: deployedIsm(ISM_B) },
    expectedTxCount: 1,
  },
  {
    name: 'ownership transfer',
    current: {},
    expected: { owner: NEW_OWNER },
    expectedTxCount: 1,
  },
  {
    name: 'no changes',
    current: {
      remoteRouters: { 1: { address: ROUTER_HEX } },
      destinationGas: { 1: '100000' },
    },
    expected: {
      remoteRouters: { 1: { address: ROUTER_HEX } },
      destinationGas: { 1: '100000' },
    },
    expectedTxCount: 0,
  },
];

describe('computeWarpTokenUpdateInstructions — feePayer', () => {
  for (const { name, current, expected, expectedTxCount } of testCases) {
    it(`${name}: ${expectedTxCount === 0 ? 'returns no txs' : 'all txs have feePayer set to owner'}`, async () => {
      const txs = await computeWarpTokenUpdateInstructions(
        makeConfig(current),
        makeConfig(expected),
        PROGRAM,
        OWNER,
        createStubRpc(),
        'test',
        DEFAULT_FEE_SALT,
      );

      expect(txs).to.have.length(expectedTxCount);
      for (const tx of txs) {
        expect(tx.feePayer).to.equal(OWNER);
      }
    });
  }
});

function feeArtifact(addr: string) {
  return {
    artifactState: ArtifactState.UNDERIVED,
    deployed: { address: addr },
  };
}

async function buildFeeConfig(
  feeProgram: string,
  salt: Uint8Array = DEFAULT_FEE_SALT,
): Promise<TokenFeeConfig> {
  const pda = await deriveFeeAccountPda(address(feeProgram), salt);
  return { feeProgram: address(feeProgram), feeAccount: pda.address };
}

describe('computeWarpTokenUpdateInstructions — fee config diff', () => {
  it('add fee: emits SetFeeConfig when current has no fee', async () => {
    const txs = await computeWarpTokenUpdateInstructions(
      makeConfig({}),
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      PROGRAM,
      OWNER,
      createStubRpc(),
      'test',
      DEFAULT_FEE_SALT,
      undefined,
    );

    expect(txs).to.have.length(1);
    expect(txs[0].annotation).to.include('fee');
  });

  it('remove fee: emits SetFeeConfig(null) when expected has no fee', async () => {
    const currentFee = await buildFeeConfig(FEE_PROGRAM_A);
    const txs = await computeWarpTokenUpdateInstructions(
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      makeConfig({}),
      PROGRAM,
      OWNER,
      createStubRpc(),
      'test',
      DEFAULT_FEE_SALT,
      currentFee,
    );

    expect(txs).to.have.length(1);
    expect(txs[0].annotation).to.include('fee');
  });

  it('change fee program: emits SetFeeConfig when program differs', async () => {
    const currentFee = await buildFeeConfig(FEE_PROGRAM_A);
    const txs = await computeWarpTokenUpdateInstructions(
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_B) }),
      PROGRAM,
      OWNER,
      createStubRpc(),
      'test',
      DEFAULT_FEE_SALT,
      currentFee,
    );

    expect(txs).to.have.length(1);
    expect(txs[0].annotation).to.include('fee');
  });

  it('same fee program but different salt: emits SetFeeConfig when PDA differs', async () => {
    const originalSalt = DEFAULT_FEE_SALT;
    const differentSalt = deriveFeeSalt('alternate-salt');
    const currentFee = await buildFeeConfig(FEE_PROGRAM_A, originalSalt);
    const txs = await computeWarpTokenUpdateInstructions(
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      PROGRAM,
      OWNER,
      createStubRpc(),
      'test',
      differentSalt,
      currentFee,
    );

    expect(txs).to.have.length(1);
    expect(txs[0].annotation).to.include('fee');
  });

  it('no-op: returns no txs when fee config matches', async () => {
    const currentFee = await buildFeeConfig(FEE_PROGRAM_A);
    const txs = await computeWarpTokenUpdateInstructions(
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      makeConfig({ fee: feeArtifact(FEE_PROGRAM_A) }),
      PROGRAM,
      OWNER,
      createStubRpc(),
      'test',
      DEFAULT_FEE_SALT,
      currentFee,
    );

    expect(txs).to.have.length(0);
  });
});
