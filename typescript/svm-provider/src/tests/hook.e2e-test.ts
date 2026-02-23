/* eslint-disable no-console */
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import {
  type SvmIgpHookConfig,
  SvmIgpHookReader,
  SvmIgpHookWriter,
  deriveIgpSalt,
} from '../hook/igp-hook.js';
import {
  type SvmMerkleTreeHookConfig,
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from '../hook/merkle-tree-hook.js';
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  TEST_PROGRAM_IDS,
  airdropSol,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<'mailbox' | 'igp'> = ['mailbox', 'igp'];

describe('SVM Hook E2E Tests', function () {
  this.timeout(60_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner & { address: string };

  before(async () => {
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);

    console.log('Starting Solana test validator with preloaded programs...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    console.log(`Validator started at: ${solana.rpcUrl}`);

    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY, rpc);

    console.log(`Airdropping SOL to ${signer.address}...`);
    await airdropSol(rpc, signer.address as any);
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  describe('Merkle Tree Hook', () => {
    it('should create and read Merkle Tree Hook (returns mailbox address)', async () => {
      const writer = new SvmMerkleTreeHookWriter(rpc, signer);

      const config: SvmMerkleTreeHookConfig = {
        type: HookType.MERKLE_TREE as 'merkleTreeHook',
        program: { programId: TEST_PROGRAM_IDS.mailbox },
      };
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      expect(receipts).to.have.length(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(HookType.MERKLE_TREE);
      expect(deployed.deployed.address).to.equal(TEST_PROGRAM_IDS.mailbox);
      expect(deployed.deployed.programId).to.equal(TEST_PROGRAM_IDS.mailbox);

      const reader = new SvmMerkleTreeHookReader(rpc);
      const readResult = await reader.read(TEST_PROGRAM_IDS.mailbox);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(HookType.MERKLE_TREE);
    });

    it('should return empty transactions for update', async () => {
      const writer = new SvmMerkleTreeHookWriter(rpc, signer);

      const artifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
        deployed: {
          address: TEST_PROGRAM_IDS.mailbox,
          programId: TEST_PROGRAM_IDS.mailbox,
        },
      };

      const updateTxs = await writer.update(artifact);
      expect(updateTxs).to.have.length(0);
    });
  });

  describe('IGP Hook', () => {
    it('should create and read IGP Hook with gas oracle configs', async function () {
      const salt = deriveIgpSalt('hyperlane-test');
      const writer = new SvmIgpHookWriter(rpc, salt, signer);

      const igpConfig: SvmIgpHookConfig = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
        program: { programId: TEST_PROGRAM_IDS.igp },
        owner: signer.address,
        beneficiary: signer.address,
        oracleKey: signer.address,
        oracleConfig: {
          1: {
            gasPrice: '50000000000',
            tokenExchangeRate: '1000000000000000000',
          },
          137: {
            gasPrice: '100000000000',
            tokenExchangeRate: '500000000000000000',
          },
        },
        overhead: {
          1: 100000,
          137: 80000,
        },
      };
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: igpConfig,
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(HookType.INTERCHAIN_GAS_PAYMASTER);
      expect(deployed.deployed.programId).to.equal(TEST_PROGRAM_IDS.igp);

      const reader = new SvmIgpHookReader(rpc, salt);
      const readResult = await reader.read(TEST_PROGRAM_IDS.igp);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(
        HookType.INTERCHAIN_GAS_PAYMASTER,
      );
    });

    it('should generate update transactions for config changes', async function () {
      const salt = deriveIgpSalt('hyperlane-update-test');
      const writer = new SvmIgpHookWriter(rpc, salt, signer);

      const updateConfig: SvmIgpHookConfig = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
        program: { programId: TEST_PROGRAM_IDS.igp },
        owner: signer.address,
        beneficiary: signer.address,
        oracleKey: signer.address,
        oracleConfig: {
          1: {
            gasPrice: '50000000000',
            tokenExchangeRate: '1000000000000000000',
          },
        },
        overhead: {
          1: 100000,
        },
      };
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: updateConfig,
      });

      const updateTxs = await writer.update({
        ...deployed,
        config: {
          ...deployed.config,
          oracleConfig: {
            ...deployed.config.oracleConfig,
            42161: {
              gasPrice: '100000000',
              tokenExchangeRate: '1000000000000000000',
            },
          },
          overhead: {
            ...deployed.config.overhead,
            42161: 50000,
          },
        },
      });

      expect(updateTxs).to.have.length.greaterThan(0);
      expect(updateTxs[0].annotation).to.include('oracle');
    });
  });

  describe('Hook Artifact Manager', () => {
    it('should detect hook type from address', async () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleHookArtifact = await manager.readHook(
        TEST_PROGRAM_IDS.mailbox,
      );
      expect(merkleHookArtifact.config.type).to.equal(HookType.MERKLE_TREE);
    });

    it('should create readers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleReader = manager.createReader(HookType.MERKLE_TREE);
      expect(merkleReader).to.be.instanceOf(SvmMerkleTreeHookReader);

      const igpReader = manager.createReader(HookType.INTERCHAIN_GAS_PAYMASTER);
      expect(igpReader).to.be.instanceOf(SvmIgpHookReader);
    });

    it('should create writers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleWriter = manager.createWriter(HookType.MERKLE_TREE, signer);
      expect(merkleWriter).to.be.instanceOf(SvmMerkleTreeHookWriter);

      const igpWriter = manager.createWriter(
        HookType.INTERCHAIN_GAS_PAYMASTER,
        signer,
      );
      expect(igpWriter).to.be.instanceOf(SvmIgpHookWriter);
    });
  });
});
