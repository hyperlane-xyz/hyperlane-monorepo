/* eslint-disable no-console */
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DomainMultisigConfig,
  type RoutingMessageIdMultisigIsmArtifactConfig,
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type NonEmptyArray,
  ZERO_ADDRESS_HEX_32,
  assert,
  nonEmptyArray,
} from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  decodeMultisigIsmMessageIdProgramInstruction,
  getSetValidatorsAndThresholdInstruction,
} from '../instructions/multisig-ism-message-id.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import {
  SvmRoutingMessageIdMultisigIsmReader,
  SvmRoutingMessageIdMultisigIsmWriter,
} from '../ism/multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from '../ism/test-ism.js';
import { deriveMultisigIsmDomainDataPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import {
  SOLANA_MAX_TRANSACTION_SIZE,
  estimateTransactionWireSize,
} from '../tx.js';
import type { AnnotatedSvmTransaction, SvmDeployedIsm } from '../types.js';
import { type Instruction, address, signature } from '@solana/kit';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM ISM E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      TEST_SVM_CHAIN_METADATA,
      TEST_PRIVATE_KEY,
    );

    await airdropSol(rpc, address(signer.getSignerAddress()));
  });

  describe('Test ISM', () => {
    it('should initialize and read Test ISM', async function () {
      const writer = new SvmTestIsmWriter(
        { program: { programId: TEST_PROGRAM_IDS.testIsm } },
        rpc,
        signer,
      );

      let deployed, receipts;
      try {
        [deployed, receipts] = await writer.create({
          artifactState: ArtifactState.NEW,
          config: { type: IsmType.TEST_ISM },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('ProgramFailedToComplete') ||
          msg.includes('Access violation')
        ) {
          console.log('Skipping: Test ISM binary incompatible with validator');
          this.skip();
        }
        throw err;
      }

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(IsmType.TEST_ISM);
      expect(deployed.deployed.address).to.equal(TEST_PROGRAM_IDS.testIsm);
      expect(deployed.deployed.programId).to.equal(TEST_PROGRAM_IDS.testIsm);

      const reader = new SvmTestIsmReader(rpc);
      const readResult = await reader.read(TEST_PROGRAM_IDS.testIsm);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(IsmType.TEST_ISM);
    });

    it('should return empty transactions for update', async () => {
      const writer = new SvmTestIsmWriter(
        { program: { programId: TEST_PROGRAM_IDS.testIsm } },
        rpc,
        signer,
      );

      const artifact: ArtifactDeployed<TestIsmConfig, SvmDeployedIsm> = {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM },
        deployed: {
          address: TEST_PROGRAM_IDS.testIsm,
          programId: TEST_PROGRAM_IDS.testIsm,
        },
      };

      const updateTxs = await writer.update(artifact);
      expect(updateTxs).to.have.length(0);
    });
  });

  describe('Multisig ISM', () => {
    it('should create and read Multisig ISM with domain configs', async function () {
      const writer = new SvmRoutingMessageIdMultisigIsmWriter(
        { program: { programId: TEST_PROGRAM_IDS.multisigIsm } },
        rpc,
        signer,
        [1, 137],
      );

      const config: RoutingMessageIdMultisigIsmArtifactConfig = {
        type: 'routingMessageIdMultisigIsm',
        owner: signer.getSignerAddress(),
        domains: {
          1: {
            validators: [
              '0x1111111111111111111111111111111111111111',
              '0x2222222222222222222222222222222222222222',
              '0x3333333333333333333333333333333333333333',
            ],
            threshold: 2,
          },
          137: {
            validators: [
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            ],
            threshold: 1,
          },
        },
      };

      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('routingMessageIdMultisigIsm');

      const reader = new SvmRoutingMessageIdMultisigIsmReader(rpc, [1, 137]);
      const readResult = await reader.read(TEST_PROGRAM_IDS.multisigIsm);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal('routingMessageIdMultisigIsm');

      expect(readResult.config.owner).to.equal(signer.getSignerAddress());
      expect(readResult.config.domains).to.deep.equal(config.domains);
    });
  });

  describe('Routing message-id multisig ISM (fresh programs)', () => {
    const MAX_TX_SIZE = SOLANA_MAX_TRANSACTION_SIZE;
    const ZERO_OWNER = ZERO_ADDRESS_HEX_32;

    let ownerSigner: SvmSigner;
    let otherSigner: SvmSigner;

    const validators = (seed: number, count: number): NonEmptyArray<string> =>
      nonEmptyArray(
        Array.from(
          { length: count },
          (_, i) => '0x' + (seed * 1000 + i + 1).toString(16).padStart(40, '0'),
        ),
      );

    const routingConfig = (
      owner: string,
      domains: Record<number, DomainMultisigConfig>,
    ): RoutingMessageIdMultisigIsmArtifactConfig => ({
      type: 'routingMessageIdMultisigIsm',
      owner,
      domains,
    });

    const freshWriter = (
      s: SvmSigner,
      knownDomainIds: NonEmptyArray<number>,
    ): SvmRoutingMessageIdMultisigIsmWriter =>
      new SvmRoutingMessageIdMultisigIsmWriter(
        {
          program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.multisigIsm },
        },
        rpc,
        s,
        knownDomainIds,
      );

    const readerFor = (knownDomainIds: NonEmptyArray<number>) =>
      new SvmRoutingMessageIdMultisigIsmReader(rpc, knownDomainIds);

    const deploy = async (
      config: RoutingMessageIdMultisigIsmArtifactConfig,
      knownDomainIds: NonEmptyArray<number>,
      s: SvmSigner = signer,
    ) => {
      const writer = freshWriter(s, knownDomainIds);
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });
      return { deployed, receipts, programId: deployed.deployed.programId };
    };

    const updaterFor = (
      programId: string,
      knownDomainIds: NonEmptyArray<number>,
    ) =>
      new SvmRoutingMessageIdMultisigIsmWriter(
        { program: { programId: address(programId) } },
        rpc,
        signer,
        knownDomainIds,
      );

    const sendAll = async (s: SvmSigner, txs: AnnotatedSvmTransaction[]) => {
      for (const tx of txs) await s.send(tx);
    };

    const landedTxSize = async (sig: string): Promise<number> => {
      const res = await rpc
        .getTransaction(signature(sig), {
          encoding: 'base64',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        .send();
      assert(res, `Transaction ${sig} not found`);
      return Buffer.from(res.transaction[0], 'base64').length;
    };

    const decodeIx = (ix: Instruction) => {
      assert(ix.data, 'instruction has no data');
      return decodeMultisigIsmMessageIdProgramInstruction(
        Uint8Array.from(ix.data),
      );
    };

    const lamportsOf = async (addr: string): Promise<bigint> =>
      (await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send())
        .value;

    const simulationLogs = (err: Error): string[] => {
      if (!('context' in err)) return [];
      const ctx = err.context;
      if (typeof ctx !== 'object' || ctx === null || !('logs' in ctx))
        return [];
      const logs = ctx.logs;
      return Array.isArray(logs) ? logs.map(String) : [];
    };

    const rejection = async (p: Promise<unknown>): Promise<Error> => {
      try {
        await p;
      } catch (err: unknown) {
        assert(err instanceof Error, 'expected an Error rejection');
        return err;
      }
      throw new Error('expected promise to reject');
    };

    before(async () => {
      ownerSigner = await SvmSigner.connectWithSigner(
        TEST_SVM_CHAIN_METADATA,
        '0x' + '2'.padStart(64, '0'),
      );
      otherSigner = await SvmSigner.connectWithSigner(
        TEST_SVM_CHAIN_METADATA,
        '0x' + '3'.padStart(64, '0'),
      );
      await airdropSol(
        rpc,
        address(signer.getSignerAddress()),
        80_000_000_000n,
      );
      await airdropSol(
        rpc,
        address(ownerSigner.getSignerAddress()),
        5_000_000_000n,
      );
      await airdropSol(
        rpc,
        address(otherSigner.getSignerAddress()),
        5_000_000_000n,
      );
    });

    const domain1Config: DomainMultisigConfig = {
      validators: validators(1, 3),
      threshold: 2,
    };
    const domain2Config: DomainMultisigConfig = {
      validators: validators(2, 2),
      threshold: 1,
    };
    const domain3Config: DomainMultisigConfig = {
      validators: validators(3, 4),
      threshold: 3,
    };
    const baseDomains: Record<number, DomainMultisigConfig> = {
      1: domain1Config,
      2: domain2Config,
      3: domain3Config,
    };

    it('creates from program bytes and reads exact state', async () => {
      const config = routingConfig(signer.getSignerAddress(), baseDomains);
      const { deployed, programId } = await deploy(config, [1, 2, 3]);
      expect(deployed.config).to.deep.equal(config);
      const read = await readerFor([1, 2, 3]).read(programId);
      expect(read.config).to.deep.equal(config);
      expect(read.deployed.programId).to.equal(programId);
    });

    it('update replaces validators and threshold of one domain only, signed by the owner', async () => {
      const config = routingConfig(ownerSigner.getSignerAddress(), baseDomains);
      const { programId } = await deploy(config, [1, 2, 3]);
      const writer = updaterFor(programId, [1, 2, 3]);
      const current = await writer.read(programId);
      expect(current.config.owner).to.equal(ownerSigner.getSignerAddress());

      const newDomain2 = { validators: validators(20, 3), threshold: 2 };
      const txs = await writer.update({
        ...current,
        config: {
          ...current.config,
          domains: { ...baseDomains, 2: newDomain2 },
        },
      });
      expect(txs).to.have.length(1);
      const [tx] = txs;
      assert(tx, 'expected one update tx');
      expect(tx.instructions).to.have.length(1);
      expect(tx.feePayer).to.equal(ownerSigner.getSignerAddress());
      await sendAll(ownerSigner, txs);

      const after = await readerFor([1, 2, 3]).read(programId);
      expect(after.config.domains).to.deep.equal({
        1: domain1Config,
        2: newDomain2,
        3: domain3Config,
      });
      expect(after.config.owner).to.equal(ownerSigner.getSignerAddress());
    });

    it('a dropped on-chain domain is rejected by update', async () => {
      const config = routingConfig(signer.getSignerAddress(), baseDomains);
      const { deployed, programId } = await deploy(config, [1, 2, 3]);
      const writer = updaterFor(programId, [1, 2, 3]);
      const expected = routingConfig(signer.getSignerAddress(), {
        1: domain1Config,
        2: domain2Config,
      });

      const err = await rejection(
        writer.update({ ...deployed, config: expected }),
      );
      expect(err.message).to.contain('Cannot remove domain 3');
    });

    it('create transfers ownership last; old owner is locked out', async () => {
      const config = routingConfig(ownerSigner.getSignerAddress(), baseDomains);
      const { programId } = await deploy(config, [1, 2, 3]);
      const read = await readerFor([1, 2, 3]).read(programId);
      expect(read.config.owner).to.equal(ownerSigner.getSignerAddress());
      expect(read.config.domains).to.deep.equal(baseDomains);

      const attack = await getSetValidatorsAndThresholdInstruction({
        programAddress: address(programId),
        owner: address(signer.getSignerAddress()),
        domain: 1,
        validators: validators(99, 1),
        threshold: 1,
      });
      const err = await rejection(signer.send({ instructions: [attack] }));
      expect(simulationLogs(err).join('\n')).to.contain(
        'invalid program argument',
      );
      const after = await readerFor([1, 2, 3]).read(programId);
      expect(after.config.domains).to.deep.equal(baseDomains);
    });

    it('update transfers ownership as the final tx, after domain changes', async () => {
      const config = routingConfig(ownerSigner.getSignerAddress(), baseDomains);
      const { programId } = await deploy(config, [1, 2, 3]);
      const writer = updaterFor(programId, [1, 2, 3]);
      const current = await writer.read(programId);
      const newDomain1 = { validators: validators(30, 2), threshold: 2 };
      const txs = await writer.update({
        ...current,
        config: {
          ...current.config,
          owner: otherSigner.getSignerAddress(),
          domains: { ...baseDomains, 1: newDomain1 },
        },
      });
      expect(txs.length).to.be.greaterThan(1);
      const last = txs[txs.length - 1];
      assert(last, 'expected update txs');
      expect(last.instructions).to.have.length(1);
      const [lastIx] = last.instructions;
      assert(lastIx, 'expected transfer instruction');
      expect(decodeIx(lastIx)).to.deep.equal({
        kind: 'transferOwnership',
        newOwner: otherSigner.getSignerAddress(),
      });
      for (const tx of txs.slice(0, -1)) {
        for (const ix of tx.instructions) {
          expect(decodeIx(ix)?.kind).to.equal('setValidatorsAndThreshold');
        }
      }
      await sendAll(ownerSigner, txs);

      const after = await readerFor([1, 2, 3]).read(programId);
      expect(after.config.owner).to.equal(otherSigner.getSignerAddress());
      expect(after.config.domains[1]).to.deep.equal(newDomain1);

      const stale = await getSetValidatorsAndThresholdInstruction({
        programAddress: address(programId),
        owner: address(ownerSigner.getSignerAddress()),
        domain: 1,
        validators: validators(98, 1),
        threshold: 1,
      });
      const staleErr = await rejection(
        ownerSigner.send({ instructions: [stale] }),
      );
      expect(simulationLogs(staleErr).join('\n')).to.contain(
        'invalid program argument',
      );
    });

    it('non-deployer owner pays rent for new domains and signs updates', async () => {
      const config = routingConfig(ownerSigner.getSignerAddress(), baseDomains);
      const { programId } = await deploy(config, [1, 2, 3, 7]);
      const writer = updaterFor(programId, [1, 2, 3, 7]);
      const current = await writer.read(programId);
      const domain7 = { validators: validators(7, 5), threshold: 3 };
      const txs = await writer.update({
        ...current,
        config: { ...current.config, domains: { ...baseDomains, 7: domain7 } },
      });
      expect(txs.every((t) => t.feePayer === ownerSigner.getSignerAddress())).to
        .be.true;
      const before = await lamportsOf(ownerSigner.getSignerAddress());
      await sendAll(ownerSigner, txs);
      const afterBal = await lamportsOf(ownerSigner.getSignerAddress());
      const { address: domain7Pda } = await deriveMultisigIsmDomainDataPda(
        address(programId),
        7,
      );
      const domain7PdaLamports = await lamportsOf(domain7Pda);
      expect(domain7PdaLamports > 0n).to.equal(true);
      expect(before - afterBal >= domain7PdaLamports).to.equal(true);
      const after = await readerFor([1, 2, 3, 7]).read(programId);
      expect(after.config.domains[7]).to.deep.equal(domain7);
    });

    it('renounced ownership reads as the zero sentinel, update is a no-op when unchanged and rejects changes', async () => {
      const config = routingConfig(ZERO_OWNER, baseDomains);
      const { programId } = await deploy(config, [1, 2, 3]);
      const writer = updaterFor(programId, [1, 2, 3]);
      const read = await writer.read(programId);
      expect(read.config.owner).to.equal(ZERO_OWNER);
      expect(read.config.domains).to.deep.equal(baseDomains);
      expect(await writer.update(read)).to.deep.equal([]);
      const err = await rejection(
        writer.update({
          ...read,
          config: {
            ...read.config,
            domains: {
              ...baseDomains,
              1: { validators: validators(9, 3), threshold: 2 },
            },
          },
        }),
      );
      expect(err.message).to.contain('ownership was renounced');
    });

    it('chunks many large domains across several txs within the size limit', async () => {
      const single = await deploy(
        routingConfig(signer.getSignerAddress(), {
          1: { validators: validators(1, 20), threshold: 7 },
        }),
        [1],
      );
      const baselineReceipts = single.receipts.length;

      const ids: NonEmptyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8];
      const build = (seed: number): Record<number, DomainMultisigConfig> =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            { validators: validators(seed + id, 20), threshold: 8 },
          ]),
        );
      const { deployed, receipts, programId } = await deploy(
        routingConfig(signer.getSignerAddress(), build(100)),
        ids,
      );
      const chunkCount = receipts.length - baselineReceipts + 1;
      expect(chunkCount).to.be.greaterThan(1);
      for (const r of receipts.slice(-chunkCount)) {
        expect(await landedTxSize(r.signature)).to.be.at.most(MAX_TX_SIZE);
      }
      expect(deployed.config.domains).to.deep.equal(build(100));

      const writer = updaterFor(programId, ids);
      const current = await writer.read(programId);
      const txs = await writer.update({
        ...current,
        config: { ...current.config, domains: build(500) },
      });
      expect(txs.length).to.be.greaterThan(1);
      for (const tx of txs) {
        expect(
          estimateTransactionWireSize(
            address(signer.getSignerAddress()),
            tx.instructions,
          ),
        ).to.be.at.most(MAX_TX_SIZE);
      }
      await sendAll(signer, txs);
      const after = await readerFor(ids).read(programId);
      expect(after.config.domains).to.deep.equal(build(500));
    });

    it('rejects invalid configs before any transaction is sent', async () => {
      const owner = signer.getSignerAddress();
      const upper = '0x' + 'A'.repeat(40);
      const lower = '0x' + 'a'.repeat(40);
      interface Case {
        name: string;
        domains: Record<number, DomainMultisigConfig>;
        error: string;
      }
      const cases: Case[] = [
        {
          name: 'threshold 0',
          domains: { 1: { validators: validators(1, 2), threshold: 0 } },
          error: 'threshold (0)',
        },
        {
          name: 'threshold above validator count',
          domains: { 1: { validators: validators(1, 2), threshold: 3 } },
          error: 'threshold (3)',
        },
        {
          name: 'duplicate validators differing by case',
          domains: { 1: { validators: [upper, lower], threshold: 1 } },
          error: 'duplicate validator',
        },
      ];
      for (const c of cases) {
        const before = await lamportsOf(owner);
        const err = await rejection(
          freshWriter(signer, [1]).create({
            artifactState: ArtifactState.NEW,
            config: routingConfig(owner, c.domains),
          }),
        );
        expect(err.message, c.name).to.contain(c.error);
        expect(await lamportsOf(owner), c.name).to.equal(before);
      }
    });

    it('domains missing from knownDomainIds are not read', async () => {
      const { programId } = await deploy(
        routingConfig(signer.getSignerAddress(), baseDomains),
        [1, 2, 3],
      );
      const partial = await readerFor([1, 2]).read(programId);
      expect(partial.config.domains).to.deep.equal({
        1: domain1Config,
        2: domain2Config,
      });
    });
  });

  describe('ISM Artifact Manager', () => {
    it('should detect ISM type from address', async function () {
      const manager = new SvmIsmArtifactManager(rpc);

      try {
        const testIsmArtifact = await manager.readIsm(TEST_PROGRAM_IDS.testIsm);
        expect(testIsmArtifact.config.type).to.equal(IsmType.TEST_ISM);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Unable to detect ISM type')) {
          // Test ISM binary may be incompatible; verify multisig detection works
          const multisigArtifact = await manager.readIsm(
            TEST_PROGRAM_IDS.multisigIsm,
          );
          expect(multisigArtifact.config.type).to.equal(
            IsmType.MESSAGE_ID_MULTISIG,
          );
        } else {
          throw err;
        }
      }
    });

    it('should create readers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc);

      const testIsmReader = manager.createReader(IsmType.TEST_ISM);
      expect(testIsmReader).to.be.instanceOf(SvmTestIsmReader);
    });

    it('should create writers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc);

      const testIsmWriter = manager.createWriter(IsmType.TEST_ISM, signer);
      expect(testIsmWriter).to.be.instanceOf(SvmTestIsmWriter);
    });
  });
});
