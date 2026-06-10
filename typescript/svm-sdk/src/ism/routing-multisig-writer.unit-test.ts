import {
  AccountRole,
  address as parseAddress,
  createNoopSigner,
  getAddressEncoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  ArtifactComposition,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { RoutingIsmArtifactConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { encodeValidatorsAndThreshold } from '../codecs/shared.js';
import { PROGRAM_INSTRUCTION_DISCRIMINATOR } from '../constants.js';
import { MultisigIsmMessageIdProgramInstructionKind } from '../instructions/multisig-ism-message-id.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';
import type { SvmRpc } from '../types.js';

import {
  computeRoutingMultisigUpdate,
  SvmRoutingMultisigWriter,
} from './routing-multisig-writer.js';

const PROGRAM_ID: Address = parseAddress(
  '2gqSMt66ZABt82TTQgrdxf7tJ4eQpLuYj6N29ieBQrH2',
);
const OWNER_A = parseAddress('zUeFx6cfxedG2JnFtMKkTXnxgPa5M44tyaF9RrPunCp');
const OWNER_B = parseAddress('11111111111111111111111111111114');

const VALIDATOR_1 = '0x1111111111111111111111111111111111111111';
const VALIDATOR_2 = '0x2222222222222222222222222222222222222222';
const VALIDATOR_3 = '0x3333333333333333333333333333333333333333';

const SIGNER = createNoopSigner(OWNER_A);

interface DomainMultisig {
  validators: string[];
  threshold: number;
}

interface DomainEntry {
  domain: number;
  config: DomainMultisig;
}

/**
 * Pre-deploy shape of the routing-multisig config — children are
 * `ArtifactEmbedded` (config only, no `.deployed`). This is what the
 * writer's create() and update() accept per the `EmbeddedArtifactWriter`
 * contract and what `computeRoutingMultisigUpdate` consumes.
 */
type EmbeddedRoutingConfig = Extract<
  RoutingIsmArtifactConfig,
  { composition: typeof ArtifactComposition.EMBEDDED }
>;

function buildEmbeddedCreateConfig(
  owner: Address,
  entries: DomainEntry[],
): EmbeddedRoutingConfig {
  const domains: EmbeddedRoutingConfig['domains'] = {};
  for (const entry of entries) {
    domains[entry.domain] = {
      artifactState: ArtifactState.EMBEDDED,
      config: {
        type: 'messageIdMultisigIsm',
        validators: entry.config.validators,
        threshold: entry.config.threshold,
      },
    };
  }
  return {
    composition: ArtifactComposition.EMBEDDED,
    type: 'domainRoutingIsm',
    owner,
    domains,
  };
}

function instructionKind(data: ReadonlyUint8Array): number {
  return data[PROGRAM_INSTRUCTION_DISCRIMINATOR.length];
}

interface Case {
  name: string;
  currentOwner: Address;
  currentDomains: Record<number, DomainMultisig>;
  expectedOwner: Address;
  expectedEntries: DomainEntry[];
  expectedTxCount: number;
  expectedKinds: MultisigIsmMessageIdProgramInstructionKind[];
}

const DOMAIN_1_CFG: DomainMultisig = {
  validators: [VALIDATOR_1, VALIDATOR_2, VALIDATOR_3],
  threshold: 2,
};
const DOMAIN_1_CFG_SWAPPED: DomainMultisig = {
  validators: [VALIDATOR_3, VALIDATOR_2, VALIDATOR_1],
  threshold: 2,
};
const DOMAIN_1_CFG_NEW_THRESHOLD: DomainMultisig = {
  validators: [VALIDATOR_1, VALIDATOR_2, VALIDATOR_3],
  threshold: 3,
};
const DOMAIN_1_CFG_NEW_VALIDATORS: DomainMultisig = {
  validators: [VALIDATOR_1, VALIDATOR_2],
  threshold: 1,
};

const cases: Case[] = [
  {
    name: 'no changes — empty diff',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_A,
    expectedEntries: [{ domain: 1, config: DOMAIN_1_CFG }],
    expectedTxCount: 0,
    expectedKinds: [],
  },
  {
    name: 'no changes — validator order differs (case-insensitive set equality)',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_A,
    expectedEntries: [{ domain: 1, config: DOMAIN_1_CFG_SWAPPED }],
    expectedTxCount: 0,
    expectedKinds: [],
  },
  {
    name: 'owner-only change → one transferOwnership tx',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_B,
    expectedEntries: [{ domain: 1, config: DOMAIN_1_CFG }],
    expectedTxCount: 1,
    expectedKinds: [
      MultisigIsmMessageIdProgramInstructionKind.TransferOwnership,
    ],
  },
  {
    name: 'add new domain → one set-validators tx',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_A,
    expectedEntries: [
      { domain: 1, config: DOMAIN_1_CFG },
      { domain: 137, config: DOMAIN_1_CFG_NEW_VALIDATORS },
    ],
    expectedTxCount: 1,
    expectedKinds: [
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
    ],
  },
  {
    name: 'threshold change → one set-validators tx',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_A,
    expectedEntries: [{ domain: 1, config: DOMAIN_1_CFG_NEW_THRESHOLD }],
    expectedTxCount: 1,
    expectedKinds: [
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
    ],
  },
  {
    name: 'validator-set change → one set-validators tx',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG },
    expectedOwner: OWNER_A,
    expectedEntries: [{ domain: 1, config: DOMAIN_1_CFG_NEW_VALIDATORS }],
    expectedTxCount: 1,
    expectedKinds: [
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
    ],
  },
  {
    name: 'owner + multi-domain reconfiguration',
    currentOwner: OWNER_A,
    currentDomains: { 1: DOMAIN_1_CFG, 137: DOMAIN_1_CFG_NEW_VALIDATORS },
    expectedOwner: OWNER_B,
    expectedEntries: [
      { domain: 1, config: DOMAIN_1_CFG_NEW_THRESHOLD },
      { domain: 137, config: DOMAIN_1_CFG_NEW_VALIDATORS },
      { domain: 8453, config: DOMAIN_1_CFG },
    ],
    expectedTxCount: 3,
    expectedKinds: [
      MultisigIsmMessageIdProgramInstructionKind.TransferOwnership,
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
    ],
  },
];

describe('computeRoutingMultisigUpdate', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const txs = await computeRoutingMultisigUpdate({
        programId: PROGRAM_ID,
        signer: SIGNER,
        currentOwner: c.currentOwner,
        currentDomains: c.currentDomains,
        expectedConfig: buildEmbeddedCreateConfig(
          c.expectedOwner,
          c.expectedEntries,
        ),
      });

      expect(txs).to.have.length(c.expectedTxCount);
      for (const tx of txs) {
        expect(tx.feePayer).to.equal(c.currentOwner);
        expect(tx.instructions).to.have.length(1);
        const ix = tx.instructions[0];
        expect(ix.programAddress).to.equal(PROGRAM_ID);
        assert(ix.accounts, 'expected instruction to include accounts');
        expect(ix.accounts[0].role).to.equal(AccountRole.WRITABLE_SIGNER);
      }

      const actualKinds = txs.map((tx) => {
        const data = tx.instructions[0].data;
        assert(data, 'instruction data must be present');
        return instructionKind(data);
      });
      expect(actualKinds).to.deep.equal(c.expectedKinds);
    });
  }

  it('throws when expected config drops an on-chain domain', async () => {
    let caught: unknown;
    try {
      await computeRoutingMultisigUpdate({
        programId: PROGRAM_ID,
        signer: SIGNER,
        currentOwner: OWNER_A,
        currentDomains: {
          1: DOMAIN_1_CFG,
          137: DOMAIN_1_CFG_NEW_VALIDATORS,
        },
        expectedConfig: buildEmbeddedCreateConfig(OWNER_A, [
          { domain: 1, config: DOMAIN_1_CFG },
        ]),
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, 'expected Error to be thrown');
    expect(caught.message).to.include('orphan PDAs');
    expect(caught.message).to.include('137');
  });
});

// ---------------------------------------------------------------------------
// SvmRoutingMultisigWriter.update — real flow with a mocked RPC.
// computeRoutingMultisigUpdate alone is not sufficient: update() must
// enumerate ACTUAL on-chain domains via getProgramAccounts, not the
// expected set, otherwise orphan detection is dead code.
// ---------------------------------------------------------------------------

const addressEncoder = getAddressEncoder();
const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

interface GetProgramAccountsEntry {
  pubkey: Address;
  account: { data: [string, 'base64'] };
}

function encodeAccessControl(bump: number, owner: Address | null): Uint8Array {
  const ownerBytes =
    owner === null
      ? new Uint8Array([0])
      : Uint8Array.from([1, ...addressEncoder.encode(owner)]);
  return Uint8Array.from([1, bump, ...ownerBytes]);
}

function encodeDomainData(
  bump: number,
  validators: string[],
  threshold: number,
): Uint8Array {
  const validatorBytes = validators.map((v) => {
    const hex = v.startsWith('0x') ? v.slice(2) : v;
    const out = new Uint8Array(20);
    for (let i = 0; i < 20; i += 1) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  });
  const payload = encodeValidatorsAndThreshold({
    validators: validatorBytes,
    threshold,
  });
  return Uint8Array.from([1, bump, ...payload]);
}

function toBase64Entry(
  pubkey: Address,
  data: Uint8Array,
): GetProgramAccountsEntry {
  return {
    pubkey,
    account: { data: [Buffer.from(data).toString('base64'), 'base64'] },
  };
}

interface MockProgramAccountsConfig {
  accessOwner: Address | null;
  domains: { domain: number; validators: string[]; threshold: number }[];
}

async function createMockRpcWithAccounts(
  programId: Address,
  config: MockProgramAccountsConfig,
): Promise<SvmRpc> {
  const { address: accessPda, bump: accessBump } =
    await deriveMultisigIsmAccessControlPda(programId);
  const entries: GetProgramAccountsEntry[] = [
    toBase64Entry(
      accessPda,
      encodeAccessControl(accessBump, config.accessOwner),
    ),
  ];
  for (const d of config.domains) {
    const { address: pda, bump } = await deriveMultisigIsmDomainDataPda(
      programId,
      d.domain,
    );
    entries.push(
      toBase64Entry(pda, encodeDomainData(bump, d.validators, d.threshold)),
    );
  }

  // CAST: Rpc<SolanaRpcApi> is a heavily-overloaded mapped type from
  // @solana/kit with dozens of method overloads and conditional return
  // types; no object literal can structurally satisfy it, and Proxy
  // dispatch is the only way to mock the dynamic method-lookup surface.
  // Proxy<{}> can't be narrowed to `SvmRpc` without the `unknown` step.
  // Mirrors the established mock pattern in src/tests/signer.unit-test.ts.
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Avoid the async-runtime thenable footgun: a Proxy whose get
        // returns a function for every property looks "thenable", so
        // `await proxy` hangs waiting for it to resolve. Returning
        // undefined for `then` makes the runtime treat the Proxy as a
        // plain value.
        if (prop === 'then') return undefined;
        if (prop === 'getProgramAccounts') {
          return () => ({ send: async () => entries });
        }
        return () => ({
          send: async () => {
            throw new Error(`Unmocked RPC method: ${String(prop)}`);
          },
        });
      },
    },
  ) as unknown as SvmRpc;
}

async function createTestSigner(rpc: SvmRpc): Promise<SvmSigner> {
  const signer = await SvmSigner.connectWithSigner(
    ['http://localhost:8899'],
    TEST_PRIVATE_KEY,
  );
  // Override the network RPC with our mock; rpc is private on SvmSigner but
  // the test pattern in signer.unit-test.ts uses this same bracket override.
  signer['rpc'] = rpc;
  return signer;
}

const SIGNER_OWNER: Address = parseAddress(
  '4ETf86tK7b4W72f27kNLJLgRWi9UfJjgH4koHGUXMFtn',
);

describe('SvmRoutingMultisigWriter.update', () => {
  it('enumerates on-chain domains and produces an update tx for a stale one', async () => {
    const rpc = await createMockRpcWithAccounts(PROGRAM_ID, {
      accessOwner: SIGNER_OWNER,
      domains: [{ domain: 1, validators: [VALIDATOR_1], threshold: 1 }],
    });
    const signer = await createTestSigner(rpc);
    const writer = new SvmRoutingMultisigWriter(
      { program: { programId: PROGRAM_ID }, candidateDomains: [1] },
      rpc,
      signer,
    );

    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: buildEmbeddedCreateConfig(SIGNER_OWNER, [
        {
          domain: 1,
          config: {
            validators: [VALIDATOR_1, VALIDATOR_2],
            threshold: 2,
          },
        },
      ]),
      deployed: { address: PROGRAM_ID, programId: PROGRAM_ID },
    });

    expect(txs).to.have.length(1);
    const data = txs[0].instructions[0].data;
    assert(data, 'instruction data must be present');
    expect(instructionKind(data)).to.equal(
      MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
    );
  });

  it('detects orphan on-chain domain not in expected config and throws', async () => {
    // Live domains on-chain: 1 and 137. Expected config has only domain 1.
    // The writer is configured with candidateDomains=[137] so the orphan
    // detection has a chance to find domain 137 — without it, the dead-code
    // bug this regresses-against would never even decode the orphan PDA.
    const rpc = await createMockRpcWithAccounts(PROGRAM_ID, {
      accessOwner: SIGNER_OWNER,
      domains: [
        { domain: 1, validators: [VALIDATOR_1], threshold: 1 },
        { domain: 137, validators: [VALIDATOR_2], threshold: 1 },
      ],
    });
    const signer = await createTestSigner(rpc);
    const writer = new SvmRoutingMultisigWriter(
      { program: { programId: PROGRAM_ID }, candidateDomains: [137] },
      rpc,
      signer,
    );

    let caught: unknown;
    try {
      await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: buildEmbeddedCreateConfig(SIGNER_OWNER, [
          { domain: 1, config: DOMAIN_1_CFG_NEW_VALIDATORS },
        ]),
        deployed: { address: PROGRAM_ID, programId: PROGRAM_ID },
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, 'expected Error to be thrown');
    expect(caught.message).to.include('orphan PDAs');
    expect(caught.message).to.include('137');
  });

  it('produces no txs when expected matches on-chain state (real flow)', async () => {
    const rpc = await createMockRpcWithAccounts(PROGRAM_ID, {
      accessOwner: SIGNER_OWNER,
      domains: [
        {
          domain: 1,
          validators: [VALIDATOR_1, VALIDATOR_2, VALIDATOR_3],
          threshold: 2,
        },
      ],
    });
    const signer = await createTestSigner(rpc);
    const writer = new SvmRoutingMultisigWriter(
      { program: { programId: PROGRAM_ID }, candidateDomains: [1] },
      rpc,
      signer,
    );

    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: buildEmbeddedCreateConfig(SIGNER_OWNER, [
        { domain: 1, config: DOMAIN_1_CFG },
      ]),
      deployed: { address: PROGRAM_ID, programId: PROGRAM_ID },
    });

    expect(txs).to.have.length(0);
  });
});
