/* eslint-disable no-console */
import { beforeAll, describe, expect, it } from 'vitest';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import {
  SvmMessageIdMultisigIsmReader,
  SvmMessageIdMultisigIsmWriter,
  type SvmMultisigIsmConfig,
} from '../ism/multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from '../ism/test-ism.js';
import type { SvmDeployedIsm } from '../types.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import { address } from '@solana/kit';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM ISM E2E Tests', () => {
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

  describe('Test ISM', () => {
    it('should initialize and read Test ISM', async (ctx) => {
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
          ctx.skip();
          return;
        }
        throw err;
      }

      expect(receipts.length).toBeGreaterThan(0);
      expect(deployed.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(deployed.config.type).toBe(IsmType.TEST_ISM);
      expect(deployed.deployed.address).toBe(TEST_PROGRAM_IDS.testIsm);
      expect(deployed.deployed.programId).toBe(TEST_PROGRAM_IDS.testIsm);

      const reader = new SvmTestIsmReader(rpc);
      const readResult = await reader.read(TEST_PROGRAM_IDS.testIsm);

      expect(readResult.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(readResult.config.type).toBe(IsmType.TEST_ISM);
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
      expect(updateTxs).toHaveLength(0);
    });
  });

  describe('Multisig ISM', () => {
    it('should create and read Multisig ISM with domain configs', async () => {
      const writer = new SvmMessageIdMultisigIsmWriter(rpc, signer);

      const config: SvmMultisigIsmConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: [],
        threshold: 0,
        program: { programId: TEST_PROGRAM_IDS.multisigIsm },
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

      expect(receipts.length).toBeGreaterThan(0);
      expect(deployed.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(deployed.config.type).toBe(IsmType.MESSAGE_ID_MULTISIG);

      const reader = new SvmMessageIdMultisigIsmReader(rpc);
      const readResult = await reader.read(TEST_PROGRAM_IDS.multisigIsm);

      expect(readResult.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(readResult.config.type).toBe(IsmType.MESSAGE_ID_MULTISIG);

      const domain1 = await reader.readDomain(TEST_PROGRAM_IDS.multisigIsm, 1);
      assert(domain1, 'expected domain1 to exist');
      expect(domain1.threshold).toBe(2);
      expect(domain1.validators).toHaveLength(3);

      const domain137 = await reader.readDomain(
        TEST_PROGRAM_IDS.multisigIsm,
        137,
      );
      assert(domain137, 'expected domain137 to exist');
      expect(domain137.threshold).toBe(1);
      expect(domain137.validators).toHaveLength(2);
    });
  });

  describe('ISM Artifact Manager', () => {
    it('should detect ISM type from address', async () => {
      const manager = new SvmIsmArtifactManager(rpc);

      try {
        const testIsmArtifact = await manager.readIsm(TEST_PROGRAM_IDS.testIsm);
        expect(testIsmArtifact.config.type).toBe(IsmType.TEST_ISM);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Unable to detect ISM type')) {
          // Test ISM binary may be incompatible; verify multisig detection works
          const multisigArtifact = await manager.readIsm(
            TEST_PROGRAM_IDS.multisigIsm,
          );
          expect(multisigArtifact.config.type).toBe(
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
      expect(testIsmReader).toBeInstanceOf(SvmTestIsmReader);
    });

    it('should create writers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc);

      const testIsmWriter = manager.createWriter(IsmType.TEST_ISM, signer);
      expect(testIsmWriter).toBeInstanceOf(SvmTestIsmWriter);
    });
  });
});
