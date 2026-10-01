import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  address as parseAddress,
  generateKeyPairSigner,
  getAddressEncoder,
  type TransactionSigner,
} from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { before, describe, it } from 'mocha';
import sinon from 'sinon';

chai.use(chaiAsPromised);

import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedIsmAddress,
  RoutingMessageIdMultisigIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type NonEmptyArray,
  ZERO_ADDRESS_HEX_32,
  assert,
  nonEmptyArray,
} from '@hyperlane-xyz/utils';

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';

import type { SvmSigner } from '../clients/signer.js';
import { concatBytes, u8, u32le } from '../codecs/binary.js';
import {
  getInitializeMultisigIsmMessageIdInstruction,
  MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD,
  MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
  ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
  getSetValidatorsAndThresholdInstruction,
  getTransferOwnershipInstruction,
  type MultisigIsmMessageIdProgramInstruction,
  decodeMultisigIsmMessageIdProgramInstruction,
} from '../instructions/multisig-ism-message-id.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';
import {
  estimateTransactionWireSize,
  SOLANA_MAX_TRANSACTION_SIZE,
} from '../tx.js';
import type { AnnotatedSvmTransaction, SvmRpc } from '../types.js';

import {
  SvmRoutingMessageIdMultisigIsmReader,
  SvmRoutingMessageIdMultisigIsmWriter,
  assertValidRoutingMessageIdMultisigIsmArtifact,
  chunkSetDomainItems,
} from './multisig-ism.js';

const PROGRAM_ID: Address = parseAddress(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const OWNER: Address = parseAddress(
  '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
);
const NEW_OWNER: Address = parseAddress(
  'Vote111111111111111111111111111111111111111',
);

const V1 = '0x1111111111111111111111111111111111111111';
const V2 = '0x2222222222222222222222222222222222222222';
const V3 = '0x3333333333333333333333333333333333333333';
const VA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const upper = (v: string) => '0x' + v.slice(2).toUpperCase();
const ADDRESS_ENCODER = getAddressEncoder();
const SIGNATURE = 'fakeSignature';

// Hand-encoded Borsh mirroring the on-chain AccessControl / DomainData account
// layouts (initialized flag, bump, then payload), independent of the decoders
// under test.
function accessControlBytes(owner: Address | null): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      u8(1),
      u8(254),
      owner === null
        ? u8(0)
        : concatBytes(u8(1), ADDRESS_ENCODER.encode(owner)),
    ),
  );
}

function domainDataBytes(validators: string[], threshold: number): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      u8(1),
      u8(253),
      u32le(validators.length),
      ...validators.map((v) => Buffer.from(v.slice(2), 'hex')),
      u8(threshold),
    ),
  );
}

class FakeChain {
  readonly accounts = new Map<string, Uint8Array>();
  readonly multipleAccountsRequestSizes: number[] = [];

  private toRpcAccount(address: string) {
    const data = this.accounts.get(address);
    if (!data) return null;
    return {
      data: [Buffer.from(data).toString('base64'), 'base64'],
      executable: false,
      lamports: 1n,
      owner: PROGRAM_ID,
      space: BigInt(data.length),
    };
  }

  readonly rpc = {
    getAccountInfo: (address: string) => ({
      send: async () => ({ value: this.toRpcAccount(address) }),
    }),
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => {
        this.multipleAccountsRequestSizes.push(addresses.length);
        return { value: addresses.map((a) => this.toRpcAccount(a)) };
      },
    }),
    // CAST: test double exposing only the RPC methods the reader uses.
  } as unknown as SvmRpc;

  // Models the account constraints of
  // rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs and its
  // state transitions. `signerAddress` is who actually signs the transaction.
  async apply(
    ix: Instruction,
    signerAddress: Address,
  ): Promise<MultisigIsmMessageIdProgramInstruction> {
    const instruction = decodeMultisigIsmMessageIdProgramInstruction(
      Uint8Array.from(ix.data ?? []),
    );
    if (!instruction) throw new Error('Unexpected non-multisig instruction');
    if (ix.programAddress !== PROGRAM_ID) {
      throw new Error(`Unexpected program ${ix.programAddress}`);
    }
    const accounts = ix.accounts ?? [];
    const { address: accessControlPda } =
      await deriveMultisigIsmAccessControlPda(PROGRAM_ID);
    const expectAccount = (
      index: number,
      address: Address,
      role: AccountRole,
    ) => {
      const meta = accounts[index];
      if (!meta || meta.address !== address || meta.role !== role) {
        throw new Error(
          `Account ${index} must be ${address} with role ${role}, got ${meta?.address} with role ${meta?.role}`,
        );
      }
    };
    // ensure_owner_signer: account 0 must be the CURRENT owner and sign.
    const expectOwnerSigner = () => {
      if (this.owner === null) throw new Error('Program has no owner');
      expectAccount(0, this.owner, AccountRole.WRITABLE_SIGNER);
      if (signerAddress !== this.owner) {
        throw new Error(`Owner ${this.owner} did not sign`);
      }
    };

    switch (instruction.kind) {
      case 'initialize':
        if (this.accounts.has(accessControlPda)) {
          throw new Error('Already initialized');
        }
        expectAccount(0, signerAddress, AccountRole.WRITABLE_SIGNER);
        expectAccount(1, accessControlPda, AccountRole.WRITABLE);
        expectAccount(2, SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY);
        await this.setAccessControl(signerAddress);
        break;
      case 'setValidatorsAndThreshold': {
        const { address: domainPda } = await deriveMultisigIsmDomainDataPda(
          PROGRAM_ID,
          instruction.value.domain,
        );
        expectOwnerSigner();
        expectAccount(1, accessControlPda, AccountRole.READONLY);
        expectAccount(2, domainPda, AccountRole.WRITABLE);
        // The program only reads the system program account when it creates
        // the domain PDA (`set_validators_and_threshold` in
        // rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs).
        if (!this.accounts.has(domainPda)) {
          expectAccount(3, SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY);
        }
        await this.setDomain(
          instruction.value.domain,
          instruction.value.data.validators.map(
            (v) => '0x' + Buffer.from(v).toString('hex'),
          ),
          instruction.value.data.threshold,
        );
        break;
      }
      case 'transferOwnership':
        expectOwnerSigner();
        expectAccount(1, accessControlPda, AccountRole.WRITABLE);
        await this.setAccessControl(instruction.newOwner);
        break;
      case 'getOwner':
        break;
    }
    return instruction;
  }

  owner: Address | null = null;

  async setAccessControl(owner: Address | null): Promise<void> {
    this.owner = owner;
    const { address } = await deriveMultisigIsmAccessControlPda(PROGRAM_ID);
    this.accounts.set(address, accessControlBytes(owner));
  }

  async setDomain(
    domain: number,
    validators: string[],
    threshold: number,
  ): Promise<void> {
    const { address } = await deriveMultisigIsmDomainDataPda(
      PROGRAM_ID,
      domain,
    );
    this.accounts.set(address, domainDataBytes(validators, threshold));
  }

  async setRawDomain(domain: number, raw: Uint8Array): Promise<void> {
    const { address } = await deriveMultisigIsmDomainDataPda(
      PROGRAM_ID,
      domain,
    );
    this.accounts.set(address, raw);
  }
}

interface SentTransaction {
  instructions: readonly Instruction[];
  decoded: MultisigIsmMessageIdProgramInstruction[];
}

// Applies each sent instruction to the fake chain, constraints included.
class FakeSigner {
  readonly sent: SentTransaction[] = [];

  constructor(
    readonly signer: TransactionSigner,
    private readonly chain: FakeChain,
  ) {}

  readonly failures: Error[] = [];
  sendAttempts = 0;

  async send(tx: { instructions: readonly Instruction[] }) {
    this.sendAttempts += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const decoded: MultisigIsmMessageIdProgramInstruction[] = [];
    for (const ix of tx.instructions) {
      decoded.push(await this.chain.apply(ix, this.signer.address));
    }
    this.sent.push({ instructions: tx.instructions, decoded });
    return { signature: SIGNATURE };
  }

  get kinds(): string[] {
    return this.sent.flatMap((tx) => tx.decoded.map((d) => d.kind));
  }
}

async function makeWriter(
  chain: FakeChain,
  knownDomainIds: NonEmptyArray<number> = [1],
): Promise<{
  writer: SvmRoutingMessageIdMultisigIsmWriter;
  signer: FakeSigner;
}> {
  const signer = new FakeSigner(await generateKeyPairSigner(), chain);
  // CAST: test double exposing only the members the writer uses.
  const svmSigner = signer as unknown as SvmSigner;
  const writer = new SvmRoutingMessageIdMultisigIsmWriter(
    { program: { programId: PROGRAM_ID } },
    chain.rpc,
    svmSigner,
    knownDomainIds,
  );
  return { writer, signer };
}

function artifactConfig(
  owner: string,
  domains: RoutingMessageIdMultisigIsmArtifactConfig['domains'],
): RoutingMessageIdMultisigIsmArtifactConfig {
  return { type: 'routingMessageIdMultisigIsm', owner, domains };
}

function deployed(config: RoutingMessageIdMultisigIsmArtifactConfig) {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config,
    deployed: { address: PROGRAM_ID, programId: PROGRAM_ID },
  };
}

function makeDomains(
  count: number,
  validatorsPerDomain: number,
): RoutingMessageIdMultisigIsmArtifactConfig['domains'] {
  const domains: RoutingMessageIdMultisigIsmArtifactConfig['domains'] = {};
  for (let domain = 1; domain <= count; domain += 1) {
    domains[domain] = {
      validators: nonEmptyArray(
        Array.from(
          { length: validatorsPerDomain },
          (_, i) =>
            '0x' + (domain * 100 + i + 1).toString(16).padStart(40, '0'),
        ),
      ),
      threshold: Math.min(6, validatorsPerDomain),
    };
  }
  return domains;
}

// Applies update() output as the on-chain owner would submit it, so the
// harness checks each instruction's account roles and addresses.
async function applyUpdateTxs(
  chain: FakeChain,
  txs: AnnotatedSvmTransaction[],
): Promise<void> {
  for (const tx of txs) {
    assert(tx.feePayer, 'update transaction must set a fee payer');
    for (const ix of tx.instructions) {
      await chain.apply(ix, tx.feePayer);
    }
  }
}

describe('SvmRoutingMessageIdMultisigIsmReader', () => {
  it('decodes two configured domains with the owner', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    await chain.setDomain(1, [V1, V2, V3], 2);
    await chain.setDomain(137, [VA, VB], 1);

    const reader = new SvmRoutingMessageIdMultisigIsmReader(
      chain.rpc,
      [1, 137],
    );
    const result = await reader.read(PROGRAM_ID);

    expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(result.deployed).to.deep.equal({
      address: PROGRAM_ID,
      programId: PROGRAM_ID,
    });
    expect(result.config).to.deep.equal({
      type: 'routingMessageIdMultisigIsm',
      owner: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
      domains: {
        1: { validators: [V1, V2, V3], threshold: 2 },
        137: { validators: [VA, VB], threshold: 1 },
      },
    });
  });

  it('omits candidate domains whose account is absent', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    await chain.setDomain(137, [VA], 1);

    const reader = new SvmRoutingMessageIdMultisigIsmReader(
      chain.rpc,
      [1, 137, 5],
    );
    const result = await reader.read(PROGRAM_ID);

    expect(Object.keys(result.config.domains)).to.deep.equal(['137']);
  });

  it('throws naming the domain and program when an account decodes to no validators', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    await chain.setDomain(7, [], 0);

    const reader = new SvmRoutingMessageIdMultisigIsmReader(chain.rpc, [7]);

    await expect(reader.read(PROGRAM_ID)).to.be.rejectedWith(
      `Corrupt multisig ISM domain 7 at program ${PROGRAM_ID}: on-chain validator set is empty`,
    );
  });

  it('throws when the program is not initialized', async () => {
    const chain = new FakeChain();
    const reader = new SvmRoutingMessageIdMultisigIsmReader(chain.rpc, [1]);

    await expect(reader.read(PROGRAM_ID)).to.be.rejectedWith(
      `Multisig ISM not initialized at program: ${PROGRAM_ID}`,
    );
  });

  it('reads a null owner as the zero sentinel', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(null);

    const reader = new SvmRoutingMessageIdMultisigIsmReader(chain.rpc, [1]);
    const result = await reader.read(PROGRAM_ID);

    expect(result.config.owner).to.equal(ZERO_ADDRESS_HEX_32);
  });

  it('throws naming the domain when a domain account is corrupt', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    // initialized flag + bump + a validator count of 5 with no validator bytes
    await chain.setRawDomain(
      137,
      Uint8Array.from(concatBytes(u8(1), u8(253), u32le(5))),
    );

    const reader = new SvmRoutingMessageIdMultisigIsmReader(chain.rpc, [137]);

    await expect(reader.read(PROGRAM_ID)).to.be.rejectedWith(
      `Failed to decode multisig ISM domain data for domain 137 at program ${PROGRAM_ID}`,
    );
  });

  it('splits more than 100 candidates into batched requests and merges the results', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    await chain.setDomain(5, [V1], 1);
    await chain.setDomain(150, [V2], 1);
    await chain.setDomain(240, [V3], 1);
    const candidates = nonEmptyArray(Array.from({ length: 250 }, (_, i) => i));

    const reader = new SvmRoutingMessageIdMultisigIsmReader(
      chain.rpc,
      candidates,
    );
    const result = await reader.read(PROGRAM_ID);

    expect(chain.multipleAccountsRequestSizes).to.deep.equal([100, 100, 50]);
    expect(result.config.domains).to.deep.equal({
      5: { validators: [V1], threshold: 1 },
      150: { validators: [V2], threshold: 1 },
      240: { validators: [V3], threshold: 1 },
    });
  });
});

const validatorSet = (count: number): NonEmptyArray<string> =>
  nonEmptyArray(
    Array.from(
      { length: count },
      (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
    ),
  );

describe('assertValidRoutingMessageIdMultisigIsmArtifact', () => {
  const CAP = MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN;
  const THRESHOLD_CAP = MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD;

  interface Case {
    name: string;
    owner?: string;
    domains: RoutingMessageIdMultisigIsmArtifactConfig['domains'];
    error?: RegExp;
  }
  const cases: Case[] = [
    {
      name: 'accepts a valid config',
      domains: { 1: { validators: [V1], threshold: 1 } },
    },
    {
      name: 'accepts an empty owner (renounce)',
      owner: '',
      domains: { 1: { validators: [V1], threshold: 1 } },
    },
    {
      name: 'rejects a non-Sealevel owner',
      owner: V1,
      domains: {},
      error: /owner/,
    },
    {
      name: 'rejects a threshold above the validator count',
      domains: { 5: { validators: [V1], threshold: 2 } },
      error: /domain 5 has threshold 2/,
    },
    {
      name: 'rejects a malformed validator',
      domains: { 8: { validators: ['0x1234'], threshold: 1 } },
      error: /domain 8 has an invalid H160 validator/,
    },
    {
      name: 'accepts a validator set at the enforced cap',
      domains: { 10: { validators: validatorSet(CAP), threshold: 1 } },
    },
    {
      name: 'rejects a validator set one above the enforced cap',
      domains: { 10: { validators: validatorSet(CAP + 1), threshold: 1 } },
      error: new RegExp(
        `^Multisig ISM domain 10 has ${CAP + 1} validators, above the enforced cap of ${CAP} `,
      ),
    },
    {
      name: 'accepts a threshold at the enforced cap',
      domains: {
        11: { validators: validatorSet(CAP), threshold: THRESHOLD_CAP },
      },
    },
    {
      name: 'rejects a threshold one above the enforced cap',
      domains: {
        11: { validators: validatorSet(CAP), threshold: THRESHOLD_CAP + 1 },
      },
      error: new RegExp(
        `^Multisig ISM domain 11 threshold \\(${THRESHOLD_CAP + 1}\\) is above the enforced cap of ${THRESHOLD_CAP} `,
      ),
    },
    {
      name: 'rejects a domain id above u32',
      domains: { 4294967296: { validators: [V1], threshold: 1 } },
      error: /Invalid multisig ISM domain/,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const run = () => {
        assertValidRoutingMessageIdMultisigIsmArtifact(
          artifactConfig(c.owner ?? OWNER, c.domains),
        );
      };
      if (c.error) expect(run).to.throw(c.error);
      else expect(run).to.not.throw();
    });
  }
});

describe('SvmRoutingMessageIdMultisigIsmWriter.create', () => {
  it('validates the config before sending any transaction', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);

    await expect(
      writer.create({
        artifactState: ArtifactState.NEW,
        config: artifactConfig(OWNER, {
          1: { validators: [V1], threshold: 1 },
          7: { validators: [V1, V2], threshold: 3 },
        }),
      }),
    ).to.be.rejectedWith(/domain 7 has threshold 3/);

    expect(signer.sent).to.have.length(0);
  });

  it('skips init when the program is already initialized and owned by the signer', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);
    await chain.setAccessControl(signer.signer.address);

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: artifactConfig(NEW_OWNER, {
        1: { validators: [V1], threshold: 1 },
      }),
    });

    expect(signer.kinds).to.deep.equal([
      'setValidatorsAndThreshold',
      'transferOwnership',
    ]);
    expect(artifact.config.owner).to.equal(NEW_OWNER);
  });

  interface RejectCase {
    name: string;
    existingOwner: typeof NEW_OWNER | null;
    message: string;
  }
  const rejectCases: RejectCase[] = [
    {
      name: 'a different owner',
      existingOwner: NEW_OWNER,
      message: `Multisig ISM ${PROGRAM_ID} is already initialized and not owned by the deploying signer`,
    },
    {
      name: 'a renounced owner',
      existingOwner: null,
      message: `Multisig ISM ${PROGRAM_ID} is already initialized and its ownership was renounced`,
    },
  ];
  for (const c of rejectCases) {
    it(`rejects before any transaction when already initialized with ${c.name}`, async () => {
      const chain = new FakeChain();
      const { writer, signer } = await makeWriter(chain);
      await chain.setAccessControl(c.existingOwner);

      await expect(
        writer.create({
          artifactState: ArtifactState.NEW,
          config: artifactConfig(OWNER, {
            1: { validators: [V1], threshold: 1 },
          }),
        }),
      ).to.be.rejectedWith(c.message);

      expect(signer.sent).to.have.length(0);
      expect(signer.sendAttempts).to.equal(0);
    });
  }

  it('retries init while the freshly deployed program is not yet visible', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);
    const race: Error & { context?: { logs: string[] } } = new Error(
      'simulation failed',
    );
    race.context = { logs: ['Program is not deployed'] };
    signer.failures.push(race);

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      let settled = false;
      const created = writer
        .create({
          artifactState: ArtifactState.NEW,
          config: artifactConfig(signer.signer.address, {}),
        })
        .finally(() => {
          settled = true;
        });
      while (!settled) {
        await clock.tickAsync(1000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await created;
    } finally {
      clock.restore();
    }

    expect(signer.sendAttempts).to.equal(2);
    expect(signer.kinds).to.deep.equal(['initialize']);
  });

  it('does not retry an init failure that is not a deployment race', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);
    const failure: Error & { context?: { logs: string[] } } = new Error(
      'insufficient funds',
    );
    failure.context = { logs: ['Transfer: insufficient lamports'] };
    signer.failures.push(failure);

    await expect(
      writer.create({
        artifactState: ArtifactState.NEW,
        config: artifactConfig(signer.signer.address, {}),
      }),
    ).to.be.rejectedWith('insufficient funds');

    expect(signer.sendAttempts).to.equal(1);
    expect(signer.sent).to.have.length(0);
  });

  it('splits many domains across transactions within the size limit and still transfers ownership last', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);
    const domains = makeDomains(30, 10);

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: artifactConfig(NEW_OWNER, domains),
    });

    const setTxs = signer.sent.filter((tx) =>
      tx.decoded.every((d) => d.kind === 'setValidatorsAndThreshold'),
    );
    expect(setTxs.length).to.be.greaterThan(1);
    expect(setTxs.flatMap((tx) => tx.instructions)).to.have.length(30);
    for (const tx of setTxs) {
      expect(
        estimateTransactionWireSize(signer.signer.address, tx.instructions),
      ).to.be.at.most(
        SOLANA_MAX_TRANSACTION_SIZE -
          ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
      );
    }
    const lastTx = signer.sent[signer.sent.length - 1];
    expect(lastTx?.decoded.map((d) => d.kind)).to.deep.equal([
      'transferOwnership',
    ]);
    expect(signer.sent[0]?.decoded[0]?.kind).to.equal('initialize');
    expect(Object.keys(artifact.config.domains)).to.have.length(30);
  });

  it('initializes, sets domains, then transfers ownership last', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);

    const [artifact, receipts] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: artifactConfig(NEW_OWNER, {
        1: { validators: [V1, V2, V3], threshold: 2 },
        137: { validators: [VA, VB], threshold: 1 },
      }),
    });

    expect(signer.kinds).to.deep.equal([
      'initialize',
      'setValidatorsAndThreshold',
      'setValidatorsAndThreshold',
      'transferOwnership',
    ]);
    expect(receipts).to.have.length(3);
    expect(chain.multipleAccountsRequestSizes).to.deep.equal([]);
    expect(artifact.config).to.deep.equal({
      type: 'routingMessageIdMultisigIsm',
      owner: NEW_OWNER,
      domains: {
        1: { validators: [V1, V2, V3], threshold: 2 },
        137: { validators: [VA, VB], threshold: 1 },
      },
    });
  });

  it('skips the transfer when the owner is the deploying signer', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: artifactConfig(signer.signer.address, {
        1: { validators: [V1], threshold: 1 },
      }),
    });

    expect(signer.kinds).to.deep.equal([
      'initialize',
      'setValidatorsAndThreshold',
    ]);
    expect(artifact.config.owner).to.equal(signer.signer.address);
  });

  it('renounces ownership last when the configured owner is empty', async () => {
    const chain = new FakeChain();
    const { writer, signer } = await makeWriter(chain);

    const [artifact] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: artifactConfig('', { 1: { validators: [V1], threshold: 1 } }),
    });

    const last = signer.sent[signer.sent.length - 1]?.decoded[0];
    expect(last).to.deep.equal({ kind: 'transferOwnership', newOwner: null });
    expect(artifact.config.owner).to.equal(ZERO_ADDRESS_HEX_32);
  });
});

describe('SvmRoutingMessageIdMultisigIsmWriter.update', () => {
  async function seededChain(): Promise<FakeChain> {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    await chain.setDomain(1, [V1, V2, V3], 2);
    await chain.setDomain(137, [VA, VB], 1);
    return chain;
  }

  it('returns no transactions when the state already matches', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137, 5]);

    const txs = await writer.update(
      deployed(
        artifactConfig(OWNER, {
          1: { validators: [V3, upper(V1), V2], threshold: 2 },
          137: { validators: [VA, VB], threshold: 1 },
        }),
      ),
    );

    expect(txs).to.deep.equal([]);
  });

  it('emits set instructions only for changed and new domains, signed by the on-chain owner', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137, 5]);

    const txs = await writer.update(
      deployed(
        artifactConfig(OWNER, {
          1: { validators: [V1, V2, V3], threshold: 2 },
          137: { validators: [VA, VB], threshold: 2 },
          5: { validators: [V1], threshold: 1 },
        }),
      ),
    );

    await applyUpdateTxs(chain, txs);
    expect(txs).to.have.length(1);
    const [tx] = txs;
    expect(tx?.feePayer).to.equal(OWNER);
    const decoded = (tx?.instructions ?? []).map((ix) =>
      decodeMultisigIsmMessageIdProgramInstruction(
        Uint8Array.from(ix.data ?? []),
      ),
    );
    expect(decoded.map((d) => d?.kind)).to.deep.equal([
      'setValidatorsAndThreshold',
      'setValidatorsAndThreshold',
    ]);
    const domains = decoded.map((d) =>
      d?.kind === 'setValidatorsAndThreshold' ? d.value.domain : null,
    );
    expect(domains).to.have.members([137, 5]);
    for (const ix of tx?.instructions ?? []) {
      expect(ix.accounts?.[0]?.address).to.equal(OWNER);
    }
  });

  describe('with domains outside the constructor candidate list', () => {
    const config = artifactConfig(OWNER, {
      1: { validators: [V1, V2, V3], threshold: 2 },
      137: { validators: [VA, VB], threshold: 1 },
    });

    it('returns no transactions on a second update of the created config', async () => {
      const chain = new FakeChain();
      const { writer } = await makeWriter(chain, [1]);
      await writer.create({ artifactState: ArtifactState.NEW, config });

      expect(await writer.update(deployed(config))).to.deep.equal([]);
    });

    it('returns no transactions on a second update of a renounced config', async () => {
      const chain = new FakeChain();
      const { writer } = await makeWriter(chain, [1]);
      await writer.create({
        artifactState: ArtifactState.NEW,
        config: artifactConfig(ZERO_ADDRESS_HEX_32, config.domains),
      });
      const renounced = artifactConfig(ZERO_ADDRESS_HEX_32, config.domains);

      expect(await writer.update(deployed(renounced))).to.deep.equal([]);
    });

    it('emits a set for only the changed out-of-list domain', async () => {
      const chain = await seededChain();
      const { writer } = await makeWriter(chain, [1]);

      const txs = await writer.update(
        deployed(
          artifactConfig(OWNER, {
            1: { validators: [V1, V2, V3], threshold: 2 },
            137: { validators: [VA, VB], threshold: 2 },
          }),
        ),
      );

      expect(txs).to.have.length(1);
      const domains = (txs[0]?.instructions ?? []).map((ix) => {
        const d = decodeMultisigIsmMessageIdProgramInstruction(
          Uint8Array.from(ix.data ?? []),
        );
        return d?.kind === 'setValidatorsAndThreshold' ? d.value.domain : null;
      });
      expect(domains).to.deep.equal([137]);
    });
  });

  it('updates the program named by an address-only deployed artifact', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137]);
    const artifact: ArtifactDeployed<
      RoutingMessageIdMultisigIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifactConfig(OWNER, {
        1: { validators: [V1, V2, V3], threshold: 2 },
        137: { validators: [VA, VB], threshold: 2 },
      }),
      deployed: { address: PROGRAM_ID },
    };

    const txs = await writer.update(artifact);

    expect(txs).to.have.length(1);
    const decoded = (txs[0]?.instructions ?? []).map((ix) =>
      decodeMultisigIsmMessageIdProgramInstruction(
        Uint8Array.from(ix.data ?? []),
      ),
    );
    expect(decoded.map((d) => d?.kind)).to.deep.equal([
      'setValidatorsAndThreshold',
    ]);
    expect(
      decoded[0]?.kind === 'setValidatorsAndThreshold'
        ? decoded[0].value.domain
        : null,
    ).to.equal(137);
  });

  it('transfers ownership as the final transaction', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137]);

    const txs = await writer.update(
      deployed(
        artifactConfig(NEW_OWNER, {
          1: { validators: [V1], threshold: 1 },
          137: { validators: [VA, VB], threshold: 1 },
        }),
      ),
    );

    await applyUpdateTxs(chain, txs);
    const kinds = txs.flatMap((tx) =>
      tx.instructions.map(
        (ix) =>
          decodeMultisigIsmMessageIdProgramInstruction(
            Uint8Array.from(ix.data ?? []),
          )?.kind,
      ),
    );
    expect(kinds).to.deep.equal([
      'setValidatorsAndThreshold',
      'transferOwnership',
    ]);
    expect(txs.every((tx) => tx.feePayer === OWNER)).to.equal(true);
  });

  it('renounces ownership when the expected owner is empty', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137]);

    const txs = await writer.update(
      deployed(
        artifactConfig('', {
          1: { validators: [V1, V2, V3], threshold: 2 },
          137: { validators: [VA, VB], threshold: 1 },
        }),
      ),
    );

    await applyUpdateTxs(chain, txs);
    expect(txs).to.have.length(1);
    expect(
      decodeMultisigIsmMessageIdProgramInstruction(
        Uint8Array.from(txs[0]?.instructions[0]?.data ?? []),
      ),
    ).to.deep.equal({ kind: 'transferOwnership', newOwner: null });
  });

  it('splits updates into transactions that fit the wire size limit with room for Squads wrapping', async () => {
    const chain = new FakeChain();
    await chain.setAccessControl(OWNER);
    const domains = makeDomains(30, 10);
    const { writer } = await makeWriter(chain, [1]);
    await chain.setDomain(1, [V1], 1);

    const txs = await writer.update(deployed(artifactConfig(OWNER, domains)));

    await applyUpdateTxs(chain, txs);
    expect(txs.length).to.be.greaterThan(1);
    expect(txs.flatMap((tx) => tx.instructions)).to.have.length(30);
    for (const tx of txs) {
      expect(estimateTransactionWireSize(OWNER, tx.instructions)).to.be.at.most(
        SOLANA_MAX_TRANSACTION_SIZE -
          ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
      );
    }
  });

  interface UpdateChunkCase {
    name: string;
    validatorsPerDomain: number;
    domainCount: number;
  }
  const updateChunkCases: UpdateChunkCase[] = [
    { name: '1-validator domains', validatorsPerDomain: 1, domainCount: 30 },
    { name: '5-validator domains', validatorsPerDomain: 5, domainCount: 20 },
    { name: '10-validator domains', validatorsPerDomain: 10, domainCount: 15 },
    { name: '20-validator domains', validatorsPerDomain: 20, domainCount: 6 },
    {
      name: 'domains at the enforced cap',
      validatorsPerDomain:
        MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
      domainCount: 4,
    },
  ];
  for (const c of updateChunkCases) {
    it(`keeps multi-domain updates of ${c.name} within the limit less the Squads reservation`, async () => {
      const chain = new FakeChain();
      await chain.setAccessControl(OWNER);
      await chain.setDomain(1, [V1], 1);
      const { writer } = await makeWriter(chain, [1]);

      const txs = await writer.update(
        deployed(
          artifactConfig(
            OWNER,
            makeDomains(c.domainCount, c.validatorsPerDomain),
          ),
        ),
      );

      await applyUpdateTxs(chain, txs);
      expect(txs.flatMap((tx) => tx.instructions)).to.have.length(
        c.domainCount,
      );
      for (const tx of txs) {
        expect(
          estimateTransactionWireSize(OWNER, tx.instructions),
        ).to.be.at.most(
          SOLANA_MAX_TRANSACTION_SIZE -
            ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
        );
      }
    });
  }

  describe('when the on-chain owner is unset', () => {
    async function renouncedChain(): Promise<FakeChain> {
      const chain = new FakeChain();
      await chain.setAccessControl(null);
      await chain.setDomain(1, [V1], 1);
      return chain;
    }

    it('returns no transactions when the state already matches', async () => {
      const chain = await renouncedChain();
      const { writer } = await makeWriter(chain, [1]);

      const txs = await writer.update(
        deployed(
          artifactConfig(ZERO_ADDRESS_HEX_32, {
            1: { validators: [V1], threshold: 1 },
          }),
        ),
      );

      expect(txs).to.deep.equal([]);
    });

    it('rejects a domain change naming the domains', async () => {
      const chain = await renouncedChain();
      const { writer } = await makeWriter(chain, [1]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(ZERO_ADDRESS_HEX_32, {
              1: { validators: [V2], threshold: 1 },
            }),
          ),
        ),
      ).to.be.rejectedWith(
        `Cannot update domains 1 of multisig ISM ${PROGRAM_ID}: ownership was renounced`,
      );
    });

    it('rejects an ownership transfer', async () => {
      const chain = await renouncedChain();
      const { writer } = await makeWriter(chain, [1]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(OWNER, { 1: { validators: [V1], threshold: 1 } }),
          ),
        ),
      ).to.be.rejectedWith(
        `Cannot transfer ownership of multisig ISM ${PROGRAM_ID}: ownership was renounced`,
      );
    });
  });

  it('rejects an update that would drop a domain configured on chain', async () => {
    const chain = await seededChain();
    const { writer } = await makeWriter(chain, [1, 137]);

    await expect(
      writer.update(
        deployed(
          artifactConfig(OWNER, {
            1: { validators: [V1, V2, V3], threshold: 2 },
          }),
        ),
      ),
    ).to.be.rejectedWith(/Cannot remove domain 137/);
  });

  describe('with an existing domain above the enforced validator cap', () => {
    const OVER_CAP = MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN + 1;
    const overCapValidators = validatorSet(OVER_CAP);
    const replacementValidators = nonEmptyArray(
      Array.from(
        { length: OVER_CAP },
        (_, i) => '0x' + (i + 0x1000).toString(16).padStart(40, '0'),
      ),
    );
    const capMessage = new RegExp(
      `^Multisig ISM domain 7 has ${OVER_CAP} validators, above the enforced cap`,
    );

    async function overCapChain(): Promise<FakeChain> {
      const chain = await seededChain();
      await chain.setDomain(7, [...overCapValidators], 2);
      return chain;
    }

    it('reads the over-cap domain', async () => {
      const chain = await overCapChain();
      const reader = new SvmRoutingMessageIdMultisigIsmReader(chain.rpc, [7]);

      const artifact = await reader.read(PROGRAM_ID);

      expect(artifact.config.domains[7]?.validators).to.have.length(OVER_CAP);
    });

    it('returns no transactions for a no-op update', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [1, 137, 7]);

      const txs = await writer.update(
        deployed(
          artifactConfig(OWNER, {
            1: { validators: [V1, V2, V3], threshold: 2 },
            137: { validators: [VA, VB], threshold: 1 },
            7: { validators: overCapValidators, threshold: 2 },
          }),
        ),
      );

      expect(txs).to.deep.equal([]);
    });

    it('permits an ownership-only update', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7]);

      const txs = await writer.update(
        deployed(
          artifactConfig(NEW_OWNER, {
            7: { validators: overCapValidators, threshold: 2 },
          }),
        ),
      );

      await applyUpdateTxs(chain, txs);
      expect(txs).to.have.length(1);
      const [decoded] = (txs[0]?.instructions ?? []).map((ix) =>
        decodeMultisigIsmMessageIdProgramInstruction(
          Uint8Array.from(ix.data ?? []),
        ),
      );
      expect(decoded?.kind).to.equal('transferOwnership');
    });

    it('permits changing an unrelated domain and leaves the over-cap domain untouched', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [1, 137, 7]);

      const txs = await writer.update(
        deployed(
          artifactConfig(OWNER, {
            1: { validators: [V1, V2, V3], threshold: 2 },
            137: { validators: [VA, VB], threshold: 2 },
            7: { validators: overCapValidators, threshold: 2 },
          }),
        ),
      );

      await applyUpdateTxs(chain, txs);
      const domains = txs
        .flatMap((tx) => tx.instructions)
        .map((ix) =>
          decodeMultisigIsmMessageIdProgramInstruction(
            Uint8Array.from(ix.data ?? []),
          ),
        )
        .map((d) =>
          d?.kind === 'setValidatorsAndThreshold' ? d.value.domain : null,
        );
      expect(domains).to.deep.equal([137]);
    });

    it('rejects replacing the over-cap domain with another oversized set', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(OWNER, {
              7: { validators: replacementValidators, threshold: 2 },
            }),
          ),
        ),
      ).to.be.rejectedWith(capMessage);
    });

    it('rejects adding a new oversized domain', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7, 8]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(OWNER, {
              7: { validators: overCapValidators, threshold: 2 },
              8: { validators: overCapValidators, threshold: 2 },
            }),
          ),
        ),
      ).to.be.rejectedWith(/^Multisig ISM domain 8 has \d+ validators, above/);
    });

    it('treats an order and case only difference on the over-cap domain as unchanged', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7]);
      const reordered = nonEmptyArray(
        [...overCapValidators].reverse().map((v, i) => (i % 2 ? upper(v) : v)),
      );

      const txs = await writer.update(
        deployed(
          artifactConfig(OWNER, {
            7: { validators: reordered, threshold: 2 },
          }),
        ),
      );

      expect(txs).to.deep.equal([]);
    });

    it('rejects a threshold-only change on the over-cap domain', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(OWNER, {
              7: { validators: overCapValidators, threshold: 3 },
            }),
          ),
        ),
      ).to.be.rejectedWith(capMessage);
    });

    it('rejects a structurally invalid unchanged domain', async () => {
      const chain = await overCapChain();
      const { writer } = await makeWriter(chain, [7]);

      await expect(
        writer.update(
          deployed(
            artifactConfig(OWNER, {
              7: { validators: overCapValidators, threshold: OVER_CAP + 1 },
            }),
          ),
        ),
      ).to.be.rejectedWith(/domain 7 has threshold/);
    });
  });
});

describe('fake chain account constraints', () => {
  let deployer: TransactionSigner;
  before(async () => {
    deployer = await generateKeyPairSigner();
  });

  async function chainOwnedBy(owner: Address): Promise<FakeChain> {
    const chain = new FakeChain();
    await chain.setAccessControl(owner);
    return chain;
  }

  const patchAccount = (
    ix: Instruction,
    index: number,
    patch: Partial<AccountMeta>,
  ): Instruction => ({
    ...ix,
    accounts: (ix.accounts ?? []).map((meta, i) =>
      i === index ? { ...meta, ...patch } : meta,
    ),
  });
  const truncate = (ix: Instruction, count: number): Instruction => ({
    ...ix,
    accounts: (ix.accounts ?? []).slice(0, count),
  });

  interface Case {
    name: string;
    chain: () => Promise<FakeChain>;
    build: () => Promise<Instruction>;
    mutate: (ix: Instruction) => Instruction;
    signer: () => Address;
    error: RegExp | null;
    kind: string;
  }

  const freshChain = async () => new FakeChain();
  const setIx = () =>
    getSetValidatorsAndThresholdInstruction({
      programAddress: PROGRAM_ID,
      owner: OWNER,
      domain: 1,
      validators: [V1],
      threshold: 1,
    });
  const initIx = () =>
    getInitializeMultisigIsmMessageIdInstruction(PROGRAM_ID, deployer);
  const transferIx = () =>
    getTransferOwnershipInstruction(PROGRAM_ID, OWNER, NEW_OWNER);
  const ownedChain = () => chainOwnedBy(OWNER);
  const identity = (ix: Instruction) => ix;
  const owner = () => OWNER;
  const deployerAddress = () => deployer.address;
  const notOwner = () => NEW_OWNER;

  const cases: Case[] = [
    {
      name: 'a well-formed set instruction signed by the owner',
      chain: ownedChain,
      build: setIx,
      mutate: identity,
      signer: owner,
      error: null,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set instruction with owner as a readonly signer',
      chain: ownedChain,
      build: setIx,
      mutate: (ix) =>
        patchAccount(ix, 0, { role: AccountRole.READONLY_SIGNER }),
      signer: owner,
      error: /Account 0 must be/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set instruction with owner as a non-signer writable account',
      chain: ownedChain,
      build: setIx,
      mutate: (ix) => patchAccount(ix, 0, { role: AccountRole.WRITABLE }),
      signer: owner,
      error: /Account 0 must be/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set instruction with an address that is not the current owner',
      chain: ownedChain,
      build: setIx,
      mutate: (ix) => patchAccount(ix, 0, { address: NEW_OWNER }),
      signer: owner,
      error: /Account 0 must be/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set transaction not signed by the owner',
      chain: ownedChain,
      build: setIx,
      mutate: identity,
      signer: notOwner,
      error: /did not sign/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set instruction with a wrong domain PDA',
      chain: ownedChain,
      build: setIx,
      mutate: (ix) => patchAccount(ix, 2, { address: NEW_OWNER }),
      signer: owner,
      error: /Account 2 must be/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a set instruction without the system program when the domain PDA is created',
      chain: ownedChain,
      build: setIx,
      mutate: (ix) => truncate(ix, 3),
      signer: owner,
      error: /Account 3 must be/,
      kind: 'setValidatorsAndThreshold',
    },
    {
      name: 'a well-formed initialize instruction',
      chain: freshChain,
      build: initIx,
      mutate: identity,
      signer: deployerAddress,
      error: null,
      kind: 'initialize',
    },
    {
      name: 'an initialize instruction with too few accounts',
      chain: freshChain,
      build: initIx,
      mutate: (ix) => truncate(ix, 2),
      signer: deployerAddress,
      error: /Account 2 must be/,
      kind: 'initialize',
    },
    {
      name: 'an initialize instruction with a wrong access control PDA',
      chain: freshChain,
      build: initIx,
      mutate: (ix) => patchAccount(ix, 1, { address: NEW_OWNER }),
      signer: deployerAddress,
      error: /Account 1 must be/,
      kind: 'initialize',
    },
    {
      name: 'an initialize instruction with a readonly signer payer',
      chain: freshChain,
      build: initIx,
      mutate: (ix) =>
        patchAccount(ix, 0, { role: AccountRole.READONLY_SIGNER }),
      signer: deployerAddress,
      error: /Account 0 must be/,
      kind: 'initialize',
    },
    {
      name: 'an initialize instruction with a wrong system program',
      chain: freshChain,
      build: initIx,
      mutate: (ix) => patchAccount(ix, 2, { address: NEW_OWNER }),
      signer: deployerAddress,
      error: /Account 2 must be/,
      kind: 'initialize',
    },
    {
      name: 'an initialize on an already initialized program',
      chain: ownedChain,
      build: initIx,
      mutate: identity,
      signer: deployerAddress,
      error: /Already initialized/,
      kind: 'initialize',
    },
    {
      name: 'a well-formed transfer instruction signed by the owner',
      chain: ownedChain,
      build: transferIx,
      mutate: identity,
      signer: owner,
      error: null,
      kind: 'transferOwnership',
    },
    {
      name: 'a transfer transaction signed by a non-owner',
      chain: ownedChain,
      build: transferIx,
      mutate: identity,
      signer: notOwner,
      error: /did not sign/,
      kind: 'transferOwnership',
    },
    {
      name: 'a transfer instruction with a wrong access control PDA',
      chain: ownedChain,
      build: transferIx,
      mutate: (ix) => patchAccount(ix, 1, { address: NEW_OWNER }),
      signer: owner,
      error: /Account 1 must be/,
      kind: 'transferOwnership',
    },
    {
      name: 'a transfer instruction with a readonly access control PDA',
      chain: ownedChain,
      build: transferIx,
      mutate: (ix) => patchAccount(ix, 1, { role: AccountRole.READONLY }),
      signer: owner,
      error: /Account 1 must be/,
      kind: 'transferOwnership',
    },
    {
      name: 'a transfer instruction with owner as a non-signer',
      chain: ownedChain,
      build: transferIx,
      mutate: (ix) => patchAccount(ix, 0, { role: AccountRole.WRITABLE }),
      signer: owner,
      error: /Account 0 must be/,
      kind: 'transferOwnership',
    },
    {
      name: 'a transfer instruction with too few accounts',
      chain: ownedChain,
      build: transferIx,
      mutate: (ix) => truncate(ix, 1),
      signer: owner,
      error: /Account 1 must be/,
      kind: 'transferOwnership',
    },
  ];
  for (const c of cases) {
    it(`${c.error ? 'rejects' : 'accepts'} ${c.name}`, async () => {
      const chain = await c.chain();
      const ix = c.mutate(await c.build());

      if (c.error === null) {
        expect((await chain.apply(ix, c.signer())).kind).to.equal(c.kind);
      } else {
        await expect(chain.apply(ix, c.signer())).to.be.rejectedWith(c.error);
      }
    });
  }

  it('accepts a set instruction without the system program when the domain PDA exists', async () => {
    const chain = await chainOwnedBy(OWNER);
    await chain.setDomain(1, [V2], 1);

    const ix = truncate(await setIx(), 3);

    expect((await chain.apply(ix, OWNER)).kind).to.equal(
      'setValidatorsAndThreshold',
    );
  });
});

describe('chunkSetDomainItems', () => {
  const setItem = async (domain: number, validatorCount: number) => ({
    domain,
    instruction: await getSetValidatorsAndThresholdInstruction({
      programAddress: PROGRAM_ID,
      owner: OWNER,
      domain,
      validators: validatorSet(validatorCount),
      threshold: 1,
    }),
  });

  it('names the domain whose single instruction exceeds the transaction size limit', async () => {
    const items = [await setItem(1, 2), await setItem(9, 100)];

    expect(() => chunkSetDomainItems(items, OWNER)).to.throw(
      new RegExp(
        `^Multisig ISM domain 9 instruction \\(\\d+ bytes\\) exceeds the ${SOLANA_MAX_TRANSACTION_SIZE - ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES}-byte limit that keeps it within Solana's ${SOLANA_MAX_TRANSACTION_SIZE}-byte transaction size limit when wrapped in a Squads proposal$`,
      ),
    );
  });

  it('chunks items that each fit a transaction', async () => {
    const items = [await setItem(1, 2), await setItem(2, 2)];

    const chunks = chunkSetDomainItems(items, OWNER);

    expect(chunks.flat()).to.have.length(2);
  });

  it('fits a domain at the enforced cap alone', async () => {
    const capItem = await setItem(
      5,
      MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
    );

    expect(chunkSetDomainItems([capItem], OWNER)).to.have.length(1);
  });

  it('splits a batch that fits the plain limit but not the Squads reservation', async () => {
    const items = [await setItem(1, 20), await setItem(2, 20)];
    const plainSize = estimateTransactionWireSize(
      OWNER,
      items.map((item) => item.instruction),
    );
    expect(plainSize).to.be.at.most(SOLANA_MAX_TRANSACTION_SIZE);

    const chunks = chunkSetDomainItems(items, OWNER);

    expect(
      chunks.map((chunk) => chunk.map((item) => item.domain)),
    ).to.deep.equal([[1], [2]]);
  });
});
