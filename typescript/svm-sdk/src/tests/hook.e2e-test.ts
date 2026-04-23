import { beforeAll, describe, expect, it } from 'vitest';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  MerkleTreeHookConfig,
  IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import { SvmSigner } from '../clients/signer.js';
import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';

import {
  SvmIgpHookReader,
  SvmIgpHookWriter,
  deriveIgpSalt,
} from '../hook/igp-hook.js';
import {
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from '../hook/merkle-tree-hook.js';
import type { SvmDeployedHook } from '../types.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import { address } from '@solana/kit';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Hook E2E Tests', () => {
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  beforeAll(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );

    await airdropSol(rpc, address(signer.getSignerAddress()));
  });

  describe('Merkle Tree Hook', () => {
    it('should create and read Merkle Tree Hook (returns mailbox address)', async () => {
      const writer = new SvmMerkleTreeHookWriter(
        { mailboxAddress: TEST_PROGRAM_IDS.mailbox },
        rpc,
        signer,
      );

      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: { type: HookType.MERKLE_TREE },
      });

      expect(receipts).toHaveLength(0);
      expect(deployed.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(deployed.config.type).toBe(HookType.MERKLE_TREE);
      expect(deployed.deployed.address).toBe(TEST_PROGRAM_IDS.mailbox);
      expect(deployed.deployed.programId).toBe(TEST_PROGRAM_IDS.mailbox);

      const reader = new SvmMerkleTreeHookReader(rpc);
      const readResult = await reader.read(TEST_PROGRAM_IDS.mailbox);

      expect(readResult.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(readResult.config.type).toBe(HookType.MERKLE_TREE);
    });

    it('should return empty transactions for update', async () => {
      const writer = new SvmMerkleTreeHookWriter(
        { mailboxAddress: TEST_PROGRAM_IDS.mailbox },
        rpc,
        signer,
      );

      const artifact: ArtifactDeployed<MerkleTreeHookConfig, SvmDeployedHook> =
        {
          artifactState: ArtifactState.DEPLOYED,
          config: { type: HookType.MERKLE_TREE },
          deployed: {
            address: TEST_PROGRAM_IDS.mailbox,
            programId: TEST_PROGRAM_IDS.mailbox,
          },
        };

      const updateTxs = await writer.update(artifact);
      expect(updateTxs).toHaveLength(0);
    });
  });

  describe('IGP Hook', () => {
    it('should create and read IGP Hook with gas oracle configs', async () => {
      const salt = deriveIgpSalt('hyperlane-test');
      const writer = new SvmIgpHookWriter(
        { program: { programId: TEST_PROGRAM_IDS.igp } },
        rpc,
        salt,
        signer,
      );

      const igpConfig: IgpHookConfig = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        oracleKey: signer.getSignerAddress(),
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

      expect(receipts.length).toBeGreaterThan(0);
      expect(deployed.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(deployed.config.type).toBe(HookType.INTERCHAIN_GAS_PAYMASTER);
      expect(deployed.deployed.programId).toBe(TEST_PROGRAM_IDS.igp);

      const reader = new SvmIgpHookReader(rpc, salt);
      const readResult = await reader.read(TEST_PROGRAM_IDS.igp);

      expect(readResult.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(readResult.config.type).toBe(HookType.INTERCHAIN_GAS_PAYMASTER);
    });

    it('should generate update transactions for config changes', async () => {
      const salt = deriveIgpSalt('hyperlane-update-test');
      const writer = new SvmIgpHookWriter(
        { program: { programId: TEST_PROGRAM_IDS.igp } },
        rpc,
        salt,
        signer,
      );

      const updateConfig: IgpHookConfig = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        oracleKey: signer.getSignerAddress(),
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

      expect(updateTxs.length).toBeGreaterThan(0);
      expect(updateTxs[0].annotation).toContain('oracle');
    });
  });

  describe('Hook Artifact Manager', () => {
    it('should detect hook type from address', async () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleHookArtifact = await manager.readHook(
        TEST_PROGRAM_IDS.mailbox,
      );
      expect(merkleHookArtifact.config.type).toBe(HookType.MERKLE_TREE);
    });

    it('should create readers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleReader = manager.createReader(HookType.MERKLE_TREE);
      expect(merkleReader).toBeInstanceOf(SvmMerkleTreeHookReader);

      const igpReader = manager.createReader(HookType.INTERCHAIN_GAS_PAYMASTER);
      expect(igpReader).toBeInstanceOf(SvmIgpHookReader);
    });

    it('should create writers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, TEST_PROGRAM_IDS.mailbox);

      const merkleWriter = manager.createWriter(HookType.MERKLE_TREE, signer);
      expect(merkleWriter).toBeInstanceOf(SvmMerkleTreeHookWriter);

      const igpWriter = manager.createWriter(
        HookType.INTERCHAIN_GAS_PAYMASTER,
        signer,
      );
      expect(igpWriter).toBeInstanceOf(SvmIgpHookWriter);
    });
  });
});
