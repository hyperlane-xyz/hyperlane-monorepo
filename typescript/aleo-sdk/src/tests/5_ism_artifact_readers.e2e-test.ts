import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { RawRoutingIsmArtifactConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { normalizeConfig } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import { AleoIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

describe('5. aleo sdk ISM artifact readers e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;
  let artifactManager: AleoIsmArtifactManager;

  // Shared test validators - sorted alphabetically as required by Aleo
  const validators = [
    '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
    '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
    '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
  ].sort();

  before(async () => {
    const localnetRpc = 'http://localhost:3030';
    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

    signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: 1,
      },
    });

    // Access the aleoClient from the signer to create the artifact manager
    const aleoClient = (signer as any).aleoClient;
    artifactManager = new AleoIsmArtifactManager(aleoClient);
  });

  describe('Non composite ISMs', () => {
    describe('Test ISM (NoopIsm)', () => {
      let testIsmAddress: string;

      step('should create and read a Test ISM', async () => {
        // Create Test ISM using signer
        const { ismAddress } = await signer.createNoopIsm({});
        testIsmAddress = ismAddress;

        expect(testIsmAddress).to.be.a('string').and.not.be.empty;

        // Read using artifact manager's specific reader
        const reader = artifactManager.createReader(AltVM.IsmType.TEST_ISM);
        const readIsm = await reader.read(testIsmAddress);

        expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readIsm.config.type).to.equal(AltVM.IsmType.TEST_ISM);
        expect(readIsm.deployed.address).to.equal(testIsmAddress);
      });

      step(
        'should read Test ISM using AleoIsmArtifactManager.readIsm()',
        async () => {
          // Read using the generic readIsm method that auto-detects ISM type
          const readIsm = await artifactManager.readIsm(testIsmAddress);

          expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(readIsm.config.type).to.equal(AltVM.IsmType.TEST_ISM);
          expect(readIsm.deployed.address).to.equal(testIsmAddress);
        },
      );
    });

    describe('Message ID Multisig ISM', () => {
      let multisigIsmAddress: string;
      const threshold = 2;

      step('should create and read a MessageId Multisig ISM', async () => {
        // Create MessageId Multisig ISM using signer
        const { ismAddress } = await signer.createMessageIdMultisigIsm({
          validators,
          threshold,
        });
        multisigIsmAddress = ismAddress;

        expect(multisigIsmAddress).to.be.a('string').and.not.be.empty;

        // Read using artifact manager's specific reader
        const reader = artifactManager.createReader(
          AltVM.IsmType.MESSAGE_ID_MULTISIG,
        );
        const readIsm = await reader.read(multisigIsmAddress);

        expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readIsm.config.type).to.equal(AltVM.IsmType.MESSAGE_ID_MULTISIG);
        expect(readIsm.deployed.address).to.equal(multisigIsmAddress);

        // Verify config matches expected values
        expect(normalizeConfig(readIsm.config)).to.deep.equal(
          normalizeConfig({
            type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
            validators,
            threshold,
          }),
        );
      });

      step(
        'should read MessageId Multisig ISM using AleoIsmArtifactManager.readIsm()',
        async () => {
          // Read using the generic readIsm method that auto-detects ISM type
          const readIsm = await artifactManager.readIsm(multisigIsmAddress);

          expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(readIsm.config.type).to.equal(
            AltVM.IsmType.MESSAGE_ID_MULTISIG,
          );
          expect(readIsm.deployed.address).to.equal(multisigIsmAddress);

          // Verify config matches expected values
          expect(normalizeConfig(readIsm.config)).to.deep.equal(
            normalizeConfig({
              type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
              validators,
              threshold,
            }),
          );
        },
      );
    });

    describe('MerkleRoot Multisig ISM (unsupported)', () => {
      step('should reject creation of MerkleRoot Multisig ISM', async () => {
        const threshold = 2;
        const testValidators = validators.slice();

        // Verify that MerkleRoot Multisig ISM creation is rejected
        await expect(
          signer.createMerkleRootMultisigIsm({
            validators: testValidators,
            threshold,
          }),
        ).to.be.rejected;
      });
    });
  });

  describe('Routing ISM', () => {
    let testIsmAddress: string;
    let multisigIsmAddress: string;
    let routingIsmAddress: string;

    const DOMAIN_1 = 42;
    const DOMAIN_2 = 96;

    before(async () => {
      // Create a Test ISM for routing
      const { ismAddress: testIsm } = await signer.createNoopIsm({});
      testIsmAddress = testIsm;

      // Create a MessageId Multisig ISM for routing
      const { ismAddress: multisigIsm } =
        await signer.createMessageIdMultisigIsm({
          validators: [validators[0]],
          threshold: 1,
        });
      multisigIsmAddress = multisigIsm;
    });

    step('should create and read a Routing ISM', async () => {
      // Create Routing ISM with two routes
      const { ismAddress } = await signer.createRoutingIsm({
        routes: [
          {
            domainId: DOMAIN_1,
            ismAddress: testIsmAddress,
          },
          {
            domainId: DOMAIN_2,
            ismAddress: multisigIsmAddress,
          },
        ],
      });
      routingIsmAddress = ismAddress;

      expect(routingIsmAddress).to.be.a('string').and.not.be.empty;

      // Read using artifact manager's specific reader
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsmAddress);

      expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(readIsm.deployed.address).to.equal(routingIsmAddress);
      expect(readIsm.config.owner).to.equal(signer.getSignerAddress());

      // Verify domains
      expect(Object.keys(readIsm.config.domains)).to.have.length(2);
      expect(readIsm.config.domains[DOMAIN_1].deployed.address).to.equal(
        testIsmAddress,
      );
      expect(readIsm.config.domains[DOMAIN_2].deployed.address).to.equal(
        multisigIsmAddress,
      );
      expect(readIsm.config.domains[DOMAIN_1].artifactState).to.equal(
        ArtifactState.UNDERIVED,
      );
      expect(readIsm.config.domains[DOMAIN_2].artifactState).to.equal(
        ArtifactState.UNDERIVED,
      );
    });

    step(
      'should read Routing ISM using AleoIsmArtifactManager.readIsm()',
      async () => {
        // Read using the generic readIsm method that auto-detects ISM type
        const readIsm = await artifactManager.readIsm(routingIsmAddress);

        expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
        expect(readIsm.deployed.address).to.equal(routingIsmAddress);

        // Type cast to access routing-specific properties
        const routingConfig = readIsm.config as RawRoutingIsmArtifactConfig;
        expect(routingConfig.owner).to.equal(signer.getSignerAddress());

        // Verify domains
        expect(Object.keys(routingConfig.domains)).to.have.length(2);
        expect(routingConfig.domains[DOMAIN_1].deployed.address).to.equal(
          testIsmAddress,
        );
        expect(routingConfig.domains[DOMAIN_2].deployed.address).to.equal(
          multisigIsmAddress,
        );
      },
    );

    step('should verify nested ISM addresses can be read', async () => {
      // Read the routing ISM
      const routingIsm = await artifactManager.readIsm(routingIsmAddress);

      // Type cast to access routing-specific properties
      const routingConfig = routingIsm.config as RawRoutingIsmArtifactConfig;

      // Read the nested Test ISM from routing config
      const nestedTestIsm = await artifactManager.readIsm(
        routingConfig.domains[DOMAIN_1].deployed.address,
      );
      expect(nestedTestIsm.config.type).to.equal(AltVM.IsmType.TEST_ISM);
      expect(nestedTestIsm.deployed.address).to.equal(testIsmAddress);

      // Read the nested Multisig ISM from routing config
      const nestedMultisigIsm = await artifactManager.readIsm(
        routingConfig.domains[DOMAIN_2].deployed.address,
      );
      expect(nestedMultisigIsm.config.type).to.equal(
        AltVM.IsmType.MESSAGE_ID_MULTISIG,
      );
      expect(nestedMultisigIsm.deployed.address).to.equal(multisigIsmAddress);
    });
  });
});
