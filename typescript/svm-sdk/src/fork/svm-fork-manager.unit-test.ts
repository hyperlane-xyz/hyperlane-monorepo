import { getAddressLookupTableEncoder } from '@solana-program/address-lookup-table';
import {
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type ReadonlyUint8Array,
  AccountRole,
  address,
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  DEFAULT_COMPUTE_UNITS,
} from '../constants.js';
import { type AccountInfoRpc } from '../accounts/address-lookup-table.js';
import { createRpc } from '../rpc.js';
import { serializeUnsignedTransaction } from '../tx.js';

import {
  FORK_IMPERSONATION_AIRDROP_LAMPORTS,
  FORK_IMPERSONATION_FEE_PAYER,
} from './impersonation.js';
import { type SvmForkTransaction } from './svm-fork-config.js';
import { type SurfpoolAirdrops } from './surfpool-node.js';
import {
  buildForkReplayTransaction,
  withImpersonationAirdrop,
} from './svm-fork-manager.js';

const base58Decoder = getBase58Decoder();
const base64Decoder = getBase64Decoder();
const transactionDecoder = getTransactionDecoder();
const compiledMessageDecoder = getCompiledTransactionMessageDecoder();

// An arbitrary non-compute-budget program, so a prepended compute-budget
// instruction is easy to distinguish from the original payload instruction.
const PAYLOAD_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const FEE_PAYER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const ALT_PROGRAM = address('AddressLookupTab1e1111111111111111111111111');
const ALT_ADDRESS = address('4QwSwNriKPrz8DLW4ju5uxC2TN5cksJx6tPUPj7DGLAW');

function payloadInstruction(): Instruction {
  return {
    programAddress: PAYLOAD_PROGRAM,
    accounts: [],
    data: new Uint8Array([1, 2, 3]),
  };
}

// Deterministic distinct pubkeys: a little-endian counter in the first 4 bytes
// of an otherwise-zero 32-byte key. Any 32-byte buffer is a valid address.
function makeAddresses(count: number): Address[] {
  const out: Address[] = [];
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  for (let i = 1; i <= count; i += 1) {
    view.setUint32(0, i, true);
    out.push(address(base58Decoder.decode(bytes)));
  }
  return out;
}

/** Encodes a synthetic address-lookup-table account holding `addresses`. */
function encodeAltAccount(addresses: Address[]): Uint8Array {
  return new Uint8Array(
    getAddressLookupTableEncoder().encode({
      deactivationSlot: 18446744073709551615n,
      lastExtendedSlot: 0n,
      lastExtendedSlotStartIndex: 0,
      authority: FEE_PAYER,
      addresses,
    }),
  );
}

/** Fork-RPC double serving one synthetic ALT account via getAccountInfo. */
function mockAltRpc(
  altAddress: Address,
  accountData: Uint8Array,
): AccountInfoRpc {
  const data = base64Decoder.decode(accountData);
  const rpc = {
    getAccountInfo(queried: Address) {
      const value =
        queried === altAddress
          ? {
              data: [data, 'base64'],
              executable: false,
              lamports: 1_000_000n,
              owner: ALT_PROGRAM,
              rentEpoch: 0n,
              space: BigInt(accountData.length),
            }
          : null;
      return { send: async () => ({ context: { slot: 0n }, value }) };
    },
  };
  // CAST: kit's Rpc methods return branded PendingRpcRequest values a hand-built
  // double cannot reproduce structurally. The fork ALT-resolution path only ever
  // calls getAccountInfo (see AccountInfoRpc), so this single-method stub suffices.
  return rpc as unknown as AccountInfoRpc;
}

function decodeCompiledMessage(wireBase64: string) {
  const bytes = Buffer.from(wireBase64, 'base64');
  const decoded = transactionDecoder.decode(bytes);
  return {
    byteLength: bytes.length,
    compiled: compiledMessageDecoder.decode(decoded.messageBytes),
  };
}

function decodeInstructions(
  wireBase64: string,
  addressLookupTables?: AddressesByLookupTableAddress,
): readonly Instruction[] {
  const { compiled } = decodeCompiledMessage(wireBase64);
  return decompileTransactionMessage(compiled, {
    addressesByLookupTableAddress: addressLookupTables,
  }).instructions;
}

function decodeComputeUnitLimit(data: ReadonlyUint8Array | undefined): number {
  expect(data, 'compute-budget instruction has no data').to.not.equal(
    undefined,
  );
  const bytes = data ?? new Uint8Array();
  expect(bytes[0], 'not a SetComputeUnitLimit instruction').to.equal(2);
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(1, true);
}

describe('buildForkReplayTransaction', () => {
  // The serialized tx never carries a compute budget, so it can be reused; the
  // fork RPC is unused for these ALT-free txs.
  const rpc = createRpc('http://127.0.0.1:1');
  const { transactionBase58 } = serializeUnsignedTransaction(
    [payloadInstruction()],
    FEE_PAYER,
  );

  it('prepends the requested compute budget when computeUnits is set', async () => {
    const requestedUnits = DEFAULT_COMPUTE_UNITS * 3;
    const transaction: SvmForkTransaction = {
      transaction_base58: transactionBase58,
      computeUnits: requestedUnits,
    };

    const wire = await buildForkReplayTransaction(rpc, transaction);
    const instructions = decodeInstructions(wire);

    expect(instructions).to.have.length(2);
    expect(instructions[0].programAddress).to.equal(COMPUTE_BUDGET_PROGRAM_ID);
    expect(decodeComputeUnitLimit(instructions[0].data)).to.equal(
      requestedUnits,
    );
    expect(instructions[1].programAddress).to.equal(PAYLOAD_PROGRAM);
  });

  it('prepends the default compute budget when computeUnits is unset', async () => {
    const transaction: SvmForkTransaction = {
      transaction_base58: transactionBase58,
    };

    const wire = await buildForkReplayTransaction(rpc, transaction);
    const instructions = decodeInstructions(wire);

    // Full parity with live/Squads execution, which defaults to
    // DEFAULT_COMPUTE_UNITS when the tx carries no explicit computeUnits.
    expect(instructions).to.have.length(2);
    expect(instructions[0].programAddress).to.equal(COMPUTE_BUDGET_PROGRAM_ID);
    expect(decodeComputeUnitLimit(instructions[0].data)).to.equal(
      DEFAULT_COMPUTE_UNITS,
    );
    expect(instructions[1].programAddress).to.equal(PAYLOAD_PROGRAM);
  });

  it('preserves ALT compression when rebuilding a compressed tx', async () => {
    // A payload referencing many distinct accounts stored in one ALT, so the
    // source tx is genuinely ALT-compressed. Without re-compression the rebuilt
    // tx would inline all of them (no addressTableLookups) and balloon in size.
    const altAddresses = makeAddresses(20);
    const altMap: AddressesByLookupTableAddress = {
      [ALT_ADDRESS]: altAddresses,
    };
    const compressedPayload: Instruction = {
      programAddress: PAYLOAD_PROGRAM,
      accounts: altAddresses.map((a) => ({
        address: a,
        role: AccountRole.READONLY,
      })),
      data: new Uint8Array([9]),
    };
    const { transactionBase58: compressedBase58 } =
      serializeUnsignedTransaction([compressedPayload], FEE_PAYER, altMap);

    const altRpc = mockAltRpc(ALT_ADDRESS, encodeAltAccount(altAddresses));
    const wire = await buildForkReplayTransaction(altRpc, {
      transaction_base58: compressedBase58,
      computeUnits: DEFAULT_COMPUTE_UNITS * 3,
    });

    const { byteLength, compiled } = decodeCompiledMessage(wire);
    const lookups =
      'addressTableLookups' in compiled
        ? (compiled.addressTableLookups ?? [])
        : [];
    // Compression preserved: still one lookup table, still under the packet
    // limit. Without the re-compress step this would be [] (accounts inlined).
    expect(lookups).to.have.length(1);
    expect(lookups[0].lookupTableAddress).to.equal(ALT_ADDRESS);
    expect(byteLength).to.be.lessThan(1232);

    const instructions = decodeInstructions(wire, altMap);
    expect(instructions).to.have.length(2);
    expect(instructions[0].programAddress).to.equal(COMPUTE_BUDGET_PROGRAM_ID);
    expect(decodeComputeUnitLimit(instructions[0].data)).to.equal(
      DEFAULT_COMPUTE_UNITS * 3,
    );
    expect(instructions[1].programAddress).to.equal(PAYLOAD_PROGRAM);
  });
});

const IMPERSONATED_FEE_PAYER = FORK_IMPERSONATION_FEE_PAYER.address;
const OTHER_ADDRESS = 'F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF5';

describe('withImpersonationAirdrop', () => {
  interface Case {
    name: string;
    input: SurfpoolAirdrops | undefined;
    expected: SurfpoolAirdrops;
  }

  const cases: Case[] = [
    {
      name: 'no airdrops → funds only the fee payer at the buffer amount',
      input: undefined,
      expected: {
        addresses: [IMPERSONATED_FEE_PAYER],
        lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS,
      },
    },
    {
      name: 'existing airdrops below the buffer → appends fee payer, raises lamports',
      input: {
        addresses: [OTHER_ADDRESS],
        lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS - 1n,
      },
      expected: {
        addresses: [OTHER_ADDRESS, IMPERSONATED_FEE_PAYER],
        lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS,
      },
    },
    {
      name: 'fee payer already present above the buffer → no duplicate, keeps higher lamports',
      input: {
        addresses: [OTHER_ADDRESS, IMPERSONATED_FEE_PAYER],
        lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS + 1n,
      },
      expected: {
        addresses: [OTHER_ADDRESS, IMPERSONATED_FEE_PAYER],
        lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS + 1n,
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(withImpersonationAirdrop(c.input)).to.deep.equal(c.expected);
    });
  }
});
