import { address } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { RawNativeWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';

import { computeWarpTokenUpdateInstructions } from '../warp/warp-tx.js';
import type { SvmRpc } from '../types.js';

const OWNER = address('zUeFx6cfxedG2JnFtMKkTXnxgPa5M44tyaF9RrPunCp');
const PROGRAM = address('2gqSMt66ZABt82TTQgrdxf7tJ4eQpLuYj6N29ieBQrH2');
const ISM_A = address('11111111111111111111111111111112');
const ISM_B = address('11111111111111111111111111111113');
const NEW_OWNER = address('11111111111111111111111111111114');
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
      );

      expect(txs).to.have.length(expectedTxCount);
      for (const tx of txs) {
        expect(tx.feePayer).to.equal(OWNER);
      }
    });
  }
});
