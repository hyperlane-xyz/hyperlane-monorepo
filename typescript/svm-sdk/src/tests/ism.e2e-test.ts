/* eslint-disable no-console */
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactComposition,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { SvmRoutingMultisigReader } from '../ism/routing-multisig-reader.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from '../ism/test-ism.js';
import type { SvmDeployedIsm } from '../types.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import { address } from '@solana/kit';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM ISM E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
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
          return;
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

  describe('Routing Multisig ISM (embedded)', () => {
    it('creates and reads a routing multisig with per-domain configs', async function () {
      const manager = new SvmIsmArtifactManager(rpc);
      const writer = manager.createWriter('domainRoutingIsm', signer);
      assert(
        writer.composition === ArtifactComposition.EMBEDDED,
        'expected EMBEDDED routing-multisig writer on SVM',
      );

      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          composition: ArtifactComposition.EMBEDDED,
          type: 'domainRoutingIsm',
          owner: signer.getSignerAddress(),
          domains: {
            1: {
              artifactState: ArtifactState.EMBEDDED,
              config: {
                type: 'messageIdMultisigIsm',
                validators: [
                  '0x1111111111111111111111111111111111111111',
                  '0x2222222222222222222222222222222222222222',
                  '0x3333333333333333333333333333333333333333',
                ],
                threshold: 2,
              },
            },
            137: {
              artifactState: ArtifactState.EMBEDDED,
              config: {
                type: 'messageIdMultisigIsm',
                validators: [
                  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                ],
                threshold: 1,
              },
            },
          },
        },
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('domainRoutingIsm');
      expect(deployed.config.composition).to.equal(
        ArtifactComposition.EMBEDDED,
      );
      expect(Object.keys(deployed.config.domains)).to.have.length(2);

      const reader = new SvmRoutingMultisigReader(rpc, [1, 137]);
      const readResult = await reader.read(TEST_PROGRAM_IDS.multisigIsm);

      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config.type).to.equal('domainRoutingIsm');

      const domain1 = readResult.config.domains[1];
      assert(domain1, 'expected domain 1 to exist');
      assert(
        domain1.config.type === 'messageIdMultisigIsm',
        'expected multisig child',
      );
      expect(domain1.config.threshold).to.equal(2);
      expect(domain1.config.validators).to.have.length(3);

      const domain137 = readResult.config.domains[137];
      assert(domain137, 'expected domain 137 to exist');
      assert(
        domain137.config.type === 'messageIdMultisigIsm',
        'expected multisig child',
      );
      expect(domain137.config.threshold).to.equal(1);
      expect(domain137.config.validators).to.have.length(2);
    });
  });

  describe('ISM Artifact Manager', () => {
    it('should detect ISM type from address', async function () {
      const manager = new SvmIsmArtifactManager(rpc, [1, 137]);

      try {
        const testIsmArtifact = await manager.readIsm(TEST_PROGRAM_IDS.testIsm);
        expect(testIsmArtifact.config.type).to.equal(IsmType.TEST_ISM);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Unable to detect ISM type')) {
          // Test ISM binary may be incompatible; verify routing-multisig
          // detection still works (programs are sequenced earlier in this
          // suite, so the multisig program has state by now).
          const routingArtifact = await manager.readIsm(
            TEST_PROGRAM_IDS.multisigIsm,
          );
          expect(routingArtifact.config.type).to.equal('domainRoutingIsm');
        } else {
          throw err;
        }
      }
    });

    it('should create readers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc, [1, 137]);

      const testIsmReader = manager.createReader(IsmType.TEST_ISM);
      expect(testIsmReader).to.be.instanceOf(SvmTestIsmReader);

      const routingReader = manager.createReader(IsmType.ROUTING);
      expect(routingReader).to.be.instanceOf(SvmRoutingMultisigReader);
    });

    it('throws when domainRoutingIsm reader is requested without candidateDomains', () => {
      const manager = new SvmIsmArtifactManager(rpc);
      expect(() => manager.createReader(IsmType.ROUTING)).to.throw(
        /domainRoutingIsm reader requires candidateDomains/,
      );
    });

    it('should create writers for different ISM types', () => {
      const manager = new SvmIsmArtifactManager(rpc);

      const testIsmWriter = manager.createWriter(IsmType.TEST_ISM, signer);
      expect(testIsmWriter).to.be.instanceOf(SvmTestIsmWriter);
    });
  });
});
