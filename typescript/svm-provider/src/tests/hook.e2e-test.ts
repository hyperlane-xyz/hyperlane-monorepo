import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

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
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  airdropSol,
  getPreloadedProgramAddresses,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';
import type { SvmProgramAddresses } from '../types.js';

/**
 * Test private key (do not use in production).
 */
const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// Programs to preload for Hook tests
const PRELOADED_PROGRAMS: Array<'mailbox' | 'igp'> = ['mailbox', 'igp'];

describe('SVM Hook E2E Tests', function () {
  // Extend timeout for container startup
  this.timeout(60_000); // 1 minute (much faster with preloaded programs)

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programAddresses: SvmProgramAddresses;

  before(async () => {
    // Get preloaded program configurations
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);

    // Start Solana test validator with preloaded programs
    console.log('Starting Solana test validator with preloaded programs...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    console.log(`Validator started at: ${solana.rpcUrl}`);

    // Wait for RPC to be ready
    await waitForRpcReady(solana.rpcUrl);

    // Create RPC client and signer
    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);

    // Airdrop SOL for transaction fees
    console.log(`Airdropping SOL to ${signer.address}...`);
    await airdropSol(rpc, signer.address);

    // Get program addresses (programs are already loaded)
    programAddresses = getPreloadedProgramAddresses(PRELOADED_PROGRAMS);
    console.log('Program addresses:', programAddresses);
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  describe('Merkle Tree Hook', () => {
    it('should create and read Merkle Tree Hook (returns mailbox address)', async () => {
      const writer = new SvmMerkleTreeHookWriter(
        rpc,
        programAddresses.mailbox,
        signer,
      );

      // Create - just returns mailbox address since merkle tree is built into mailbox
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
      });

      // No transactions needed - merkle tree is part of mailbox
      expect(receipts).to.have.length(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(HookType.MERKLE_TREE);
      expect(deployed.deployed.address).to.equal(programAddresses.mailbox);

      // Read it back
      const reader = new SvmMerkleTreeHookReader(rpc, programAddresses.mailbox);
      const readResult = await reader.read(programAddresses.mailbox);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(HookType.MERKLE_TREE);
    });

    it('should return empty transactions for update', async () => {
      const writer = new SvmMerkleTreeHookWriter(
        rpc,
        programAddresses.mailbox,
        signer,
      );

      const artifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
        deployed: { address: programAddresses.mailbox },
      };

      const updateTxs = await writer.update(artifact);
      expect(updateTxs).to.have.length(0);
    });
  });

  describe('IGP Hook', () => {
    it('should create and read IGP Hook with gas oracle configs', async function () {
      if (!programAddresses.igp) {
        this.skip();
        return;
      }
      const salt = deriveIgpSalt('hyperlane-test');
      const writer = new SvmIgpHookWriter(
        rpc,
        programAddresses.igp,
        salt,
        signer,
      );

      // Create with gas oracle configurations
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
          owner: signer.address,
          beneficiary: signer.address,
          oracleKey: signer.address,
          oracleConfig: {
            1: {
              // Ethereum mainnet
              gasPrice: '50000000000', // 50 gwei
              tokenExchangeRate: '1000000000000000000', // 1:1
            },
            137: {
              // Polygon
              gasPrice: '100000000000', // 100 gwei
              tokenExchangeRate: '500000000000000000', // 0.5:1
            },
          },
          overhead: {
            1: 100000,
            137: 80000,
          },
        },
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(HookType.INTERCHAIN_GAS_PAYMASTER);

      // Read it back
      const reader = new SvmIgpHookReader(rpc, programAddresses.igp, salt);
      const readResult = await reader.read(deployed.deployed.address);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(
        HookType.INTERCHAIN_GAS_PAYMASTER,
      );
    });

    it('should generate update transactions for config changes', async function () {
      if (!programAddresses.igp) {
        this.skip();
        return;
      }
      const salt = deriveIgpSalt('hyperlane-update-test');
      const writer = new SvmIgpHookWriter(
        rpc,
        programAddresses.igp,
        salt,
        signer,
      );

      // First create the IGP
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
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
        },
      });

      // Update with new domain config
      const updateTxs = await writer.update({
        ...deployed,
        config: {
          ...deployed.config,
          oracleConfig: {
            ...deployed.config.oracleConfig,
            42161: {
              // Add Arbitrum
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

      // Should have transactions for adding the new domain
      expect(updateTxs).to.have.length.greaterThan(0);
      expect(updateTxs[0].annotation).to.include('oracle');
    });
  });

  describe('Hook Artifact Manager', () => {
    it('should detect hook type from address', async () => {
      const manager = new SvmHookArtifactManager(rpc, programAddresses);

      // Read Merkle Tree Hook
      const merkleHookArtifact = await manager.readHook(
        programAddresses.mailbox,
      );
      expect(merkleHookArtifact.config.type).to.equal(HookType.MERKLE_TREE);
    });

    it('should create readers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, programAddresses);

      const merkleReader = manager.createReader(HookType.MERKLE_TREE);
      expect(merkleReader).to.be.instanceOf(SvmMerkleTreeHookReader);

      // Note: IGP reader requires salt, so createReader returns a reader with default salt
      const igpReader = manager.createReader(HookType.INTERCHAIN_GAS_PAYMASTER);
      expect(igpReader).to.be.instanceOf(SvmIgpHookReader);
    });

    it('should create writers for different hook types', () => {
      const manager = new SvmHookArtifactManager(rpc, programAddresses);

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
