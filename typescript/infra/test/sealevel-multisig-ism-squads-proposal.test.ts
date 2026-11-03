import { getAddressEncoder, address as parseAddress } from '@solana/kit';
import {
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { getVaultPda, instructions, PROGRAM_ID } from '@sqds/multisig';
import { expect } from 'chai';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { RoutingMessageIdMultisigIsmArtifactConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  type SealevelRpc,
  type SealevelSigner,
  SealevelRoutingMessageIdMultisigIsmWriter,
} from '@hyperlane-xyz/sealevel-sdk';
import {
  type NonEmptyArray,
  assert,
  nonEmptyArray,
} from '@hyperlane-xyz/utils';

import { buildInstructionsFromPrintable } from '../src/utils/warp-propose-squads.js';

// Mirrors buildSquadsVaultTransactionProposal / createAndApproveSquadsProposal
// in ../src/utils/squads.ts without the network reads (next transaction index,
// blockhash, multisig lookup), which are replaced by dummy values that do not
// change the serialized size.
const DEFAULT_MEMO = 'Hyperlane Multisig ISM Update';
const WARP_BATCH_MEMO = `Hyperlane warp apply batch (12 tx) for ${'x'.repeat(14)} (12/12)`;
const BLOCKHASH = '11111111111111111111111111111111';
const MAX_SQUADS_MEMO_LENGTH = 64;

const ISM_PROGRAM = parseAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ADDRESS_ENCODER = getAddressEncoder();

const multisigPda = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const [vault] = getVaultPda({ multisigPda, index: 0, programId: PROGRAM_ID });

// Hand-encoded access-control account: initialized flag, bump, Some(owner).
function accessControlData(owner: Uint8Array): string {
  return Buffer.concat([Buffer.from([1, 254, 1]), Buffer.from(owner)]).toString(
    'base64',
  );
}

function makeWriter(): SealevelRoutingMessageIdMultisigIsmWriter {
  const accessControl = accessControlData(
    Uint8Array.from(ADDRESS_ENCODER.encode(parseAddress(vault.toBase58()))),
  );
  const rpc = {
    getAccountInfo: () => ({
      send: async () => ({
        value: {
          data: [accessControl, 'base64'],
          executable: false,
          lamports: 1n,
          owner: ISM_PROGRAM,
          space: 35n,
        },
      }),
    }),
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({ value: addresses.map(() => null) }),
    }),
    // CAST: test double exposing only the RPC methods the reader uses.
  } as unknown as SealevelRpc;
  // CAST: test double; update() never uses the signer.
  const signer = {} as unknown as SealevelSigner;
  return new SealevelRoutingMessageIdMultisigIsmWriter(
    { program: { programId: ISM_PROGRAM } },
    rpc,
    signer,
    nonEmptyArray(Array.from({ length: 30 }, (_, i) => i + 1)),
  );
}

function makeConfig(
  domainCount: number,
  validatorsPerDomain: number,
): RoutingMessageIdMultisigIsmArtifactConfig {
  const domains: RoutingMessageIdMultisigIsmArtifactConfig['domains'] = {};
  for (let domain = 1; domain <= domainCount; domain += 1) {
    const validators: NonEmptyArray<string> = nonEmptyArray(
      Array.from(
        { length: validatorsPerDomain },
        (_, i) => '0x' + (domain * 100 + i + 1).toString(16).padStart(40, '0'),
      ),
    );
    domains[domain] = {
      validators,
      threshold: Math.min(5, validatorsPerDomain),
    };
  }
  return {
    type: 'routingMessageIdMultisigIsm',
    owner: vault.toBase58(),
    domains,
  };
}

// Serialization throws when the transaction exceeds the packet size.
function squadsProposalSize(
  inner: TransactionInstruction[],
  memo: string,
  withPriorityFee: boolean,
): number {
  const vaultTxIx = instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: 1n,
    creator,
    rentPayer: creator,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: vault,
      recentBlockhash: BLOCKHASH,
      instructions: inner,
    }),
    memo,
    programId: PROGRAM_ID,
  });
  const proposalIx = instructions.proposalCreate({
    multisigPda,
    transactionIndex: 1n,
    creator,
    rentPayer: creator,
    programId: PROGRAM_ID,
  });
  const tx = new Transaction({
    feePayer: creator,
    recentBlockhash: BLOCKHASH,
  });
  if (withPriorityFee) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  }
  tx.add(vaultTxIx, proposalIx);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    .length;
}

interface Case {
  name: string;
  domainCount: number;
  validatorsPerDomain: number;
}

describe('routing multisig ISM updates wrapped in a Squads proposal', () => {
  const cases: Case[] = [
    {
      name: 'a single 24-validator domain',
      domainCount: 1,
      validatorsPerDomain: 24,
    },
    { name: '30 1-validator domains', domainCount: 30, validatorsPerDomain: 1 },
    { name: '30 5-validator domains', domainCount: 30, validatorsPerDomain: 5 },
    {
      name: '30 10-validator domains',
      domainCount: 30,
      validatorsPerDomain: 10,
    },
    {
      name: '30 20-validator domains',
      domainCount: 30,
      validatorsPerDomain: 20,
    },
    {
      name: '30 24-validator domains',
      domainCount: 30,
      validatorsPerDomain: 24,
    },
  ];

  for (const c of cases) {
    it(`fits every update transaction for ${c.name} in a Squads proposal`, async () => {
      const txs = await makeWriter().update({
        artifactState: ArtifactState.DEPLOYED,
        config: makeConfig(c.domainCount, c.validatorsPerDomain),
        deployed: { address: ISM_PROGRAM },
      });

      expect(txs.flatMap((tx) => tx.instructions)).to.have.length(
        c.domainCount,
      );
      for (const tx of txs) {
        const inner = buildInstructionsFromPrintable(
          tx.instructions.map((ix) => {
            assert(ix.accounts, 'instruction must list accounts');
            assert(ix.data, 'instruction must carry data');
            return {
              programAddress: ix.programAddress,
              accounts: ix.accounts.map((account) => ({
                address: account.address,
                role: account.role,
              })),
              data: Buffer.from(ix.data).toString('hex'),
            };
          }),
        );
        for (const memo of [DEFAULT_MEMO, WARP_BATCH_MEMO]) {
          expect(memo.length).to.be.at.most(MAX_SQUADS_MEMO_LENGTH);
          for (const withPriorityFee of [false, true]) {
            expect(
              squadsProposalSize(inner, memo, withPriorityFee),
            ).to.be.at.most(PACKET_DATA_SIZE);
          }
        }
      }
    });
  }
});
