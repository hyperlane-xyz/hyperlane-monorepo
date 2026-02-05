import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import {
  SvmMessageIdMultisigIsmReader,
  SvmMessageIdMultisigIsmWriter,
  type SvmMultisigIsmConfig,
} from '../ism/multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from '../ism/test-ism.js';
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
 * This generates a deterministic keypair for testing.
 */
const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// Programs to preload for ISM tests
const PRELOADED_PROGRAMS: Array<'testIsm' | 'multisigIsm'> = [
  'testIsm',
  'multisigIsm',
];

describe('SVM ISM E2E Tests', function () {
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

  describe('Test ISM', () => {
    it('should initialize and read Test ISM', async () => {
      const writer = new SvmTestIsmWriter(
        rpc,
        programAddresses.testIsm,
        signer,
      );

      // Create (initialize) the Test ISM
      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: { type: IsmType.TEST_ISM as 'testIsm' },
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal(IsmType.TEST_ISM);
      expect(deployed.deployed.address).to.equal(programAddresses.testIsm);

      // Read it back
      const reader = new SvmTestIsmReader(rpc, programAddresses.testIsm);
      const readResult = await reader.read(programAddresses.testIsm);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(IsmType.TEST_ISM);
    });

    it('should return empty transactions for update', async () => {
      const writer = new SvmTestIsmWriter(
        rpc,
        programAddresses.testIsm,
        signer,
      );

      const artifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM as 'testIsm' },
        deployed: { address: programAddresses.testIsm },
      };

      const updateTxs = await writer.update(artifact);
      expect(updateTxs).to.have.length(0);
    });
  });

  describe('Multisig ISM', () => {
    it('should create and read Multisig ISM with domain configs', async function () {
      if (!programAddresses.multisigIsm) {
        this.skip();
        return;
      }
      const writer = new SvmMessageIdMultisigIsmWriter(
        rpc,
        programAddresses.multisigIsm,
        signer,
      );

      // Create with domain configurations (using SvmMultisigIsmConfig)
      const config: SvmMultisigIsmConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG as 'messageIdMultisigIsm',
        validators: [], // Required by base type but we use domains
        threshold: 0,
        domains: {
          1: {
            // Ethereum mainnet
            validators: [
              '0x1111111111111111111111111111111111111111',
              '0x2222222222222222222222222222222222222222',
              '0x3333333333333333333333333333333333333333',
            ],
            threshold: 2,
          },
          137: {
            // Polygon
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
      expect(deployed.config.type).to.equal(IsmType.MESSAGE_ID_MULTISIG);

      // Read it back
      const reader = new SvmMessageIdMultisigIsmReader(
        rpc,
        programAddresses.multisigIsm,
      );
      const readResult = await reader.read(programAddresses.multisigIsm);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal(IsmType.MESSAGE_ID_MULTISIG);

      // Read specific domain data
      const domain1 = await reader.readDomain(1);
      expect(domain1).to.not.be.null;
      expect(domain1!.threshold).to.equal(2);
      expect(domain1!.validators).to.have.length(3);

      const domain137 = await reader.readDomain(137);
      expect(domain137).to.not.be.null;
      expect(domain137!.threshold).to.equal(1);
      expect(domain137!.validators).to.have.length(2);
    });
  });

  describe('ISM Artifact Manager', () => {
    it('should detect ISM type from address', async () => {
      const manager = new SvmIsmArtifactManager(rpc, programAddresses);

      // Read Test ISM
      const testIsmArtifact = await manager.readIsm(programAddresses.testIsm);
      expect(testIsmArtifact.config.type).to.equal(IsmType.TEST_ISM);
    });

    it('should create readers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc, programAddresses);

      const testIsmReader = manager.createReader(IsmType.TEST_ISM);
      expect(testIsmReader).to.be.instanceOf(SvmTestIsmReader);
    });

    it('should create writers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc, programAddresses);

      const testIsmWriter = manager.createWriter(IsmType.TEST_ISM, signer);
      expect(testIsmWriter).to.be.instanceOf(SvmTestIsmWriter);
    });
  });
});
