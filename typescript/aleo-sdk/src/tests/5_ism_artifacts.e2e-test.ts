import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM, IsmArtifactManager } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type IsmType,
  type MultisigIsmConfig,
  type RawRoutingIsmArtifactConfig,
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { normalizeConfig } from '@hyperlane-xyz/utils';

import { AleoProvider } from '../clients/provider.js';
import { AleoSigner } from '../clients/signer.js';

chai.use(chaiAsPromised);

describe('5. aleo sdk ISM artifacts (readers and writers) e2e tests', async function () {
  this.timeout(100_000);

  let provider: AleoProvider;
  let signer: AleoSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: IsmArtifactManager;

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

    provider = await AleoProvider.connect([localnetRpc], 1);

    signer = (await AleoSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: 1,
      },
    })) as AleoSigner;

    providerSdkSigner = signer;

    artifactManager = new IsmArtifactManager(provider);
  });

  describe('Non composite ISMs', () => {
    const testCases: Array<{
      name: string;
      type: IsmType;
      config: TestIsmConfig | MultisigIsmConfig;
      verifyConfig?: (config: any) => void;
    }> = [
      {
        name: 'Test ISM',
        type: AltVM.IsmType.TEST_ISM,
        config: { type: AltVM.IsmType.TEST_ISM },
      },
      {
        name: 'MessageId Multisig ISM',
        type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
        config: {
          type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
          validators,
          threshold: 2,
        },
        verifyConfig: (config: MultisigIsmConfig) => {
          expect(normalizeConfig(config)).to.deep.equal(
            normalizeConfig({
              type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
              validators,
              threshold: 2,
            }),
          );
        },
      },
    ];

    testCases.forEach(({ name, type, config, verifyConfig }) => {
      describe(name, () => {
        it(`should create a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, signer);
          const [result, receipts] = await writer.create({ config });

          expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(result.config.type).to.equal(type);
          expect(result.deployed.address).to.be.a('string').and.not.be.empty;
          expect(receipts).to.be.an('array').with.length.greaterThan(0);
        });

        it(`should read a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, signer);
          const [deployedIsm] = await writer.create({ config });

          const reader = artifactManager.createReader(type);
          const readIsm = await reader.read(deployedIsm.deployed.address);

          expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(readIsm.config.type).to.equal(type);
          expect(readIsm.deployed.address).to.equal(
            deployedIsm.deployed.address,
          );

          if (verifyConfig) {
            verifyConfig(readIsm.config);
          }
        });

        it(`should read ${name} using AleoIsmArtifactManager.readIsm()`, async () => {
          const writer = artifactManager.createWriter(type, signer);
          const [deployedIsm] = await writer.create({ config });

          const readIsm = await artifactManager.readIsm(
            deployedIsm.deployed.address,
          );

          expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(readIsm.config.type).to.equal(type);
          expect(readIsm.deployed.address).to.equal(
            deployedIsm.deployed.address,
          );

          if (verifyConfig) {
            verifyConfig(readIsm.config);
          }
        });

        it('should return no transactions when calling update', async () => {
          const writer = artifactManager.createWriter(type, signer);
          const [deployedIsm] = await writer.create({ config });

          const txs = await writer.update(deployedIsm);
          expect(txs).to.be.an('array').with.length(0);
        });
      });
    });

    describe('MerkleRoot Multisig ISM (unsupported)', () => {
      it('should reject creation of MerkleRoot Multisig ISM', async () => {
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

  describe(AltVM.IsmType.ROUTING, () => {
    let testIsmAddress: string;
    let multisigIsmAddress: string;

    const DOMAIN_1 = 42;
    const DOMAIN_2 = 96;
    const DOMAIN_3 = 100;

    before(async () => {
      // Create Test ISM for routing
      const testWriter = artifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        signer,
      );
      const [testIsm] = await testWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });
      testIsmAddress = testIsm.deployed.address;

      // Create MessageId Multisig ISM for routing
      const multisigWriter = artifactManager.createWriter(
        AltVM.IsmType.MESSAGE_ID_MULTISIG,
        signer,
      );
      const [multisigIsm] = await multisigWriter.create({
        config: {
          type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
          validators: [validators[0]],
          threshold: 1,
        },
      });
      multisigIsmAddress = multisigIsm.deployed.address;
    });

    it('should create and read the provided config', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      expect(routingIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(routingIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(routingIsm.deployed.address).to.be.a('string').and.not.be.empty;

      // Read using artifact manager's specific reader
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);

      expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(readIsm.config.owner).to.equal(signer.getSignerAddress());
      expect(Object.keys(readIsm.config.domains)).to.have.length(2);
      expect(readIsm.config.domains[DOMAIN_1].deployed.address).to.equal(
        testIsmAddress,
      );
      expect(readIsm.config.domains[DOMAIN_2].deployed.address).to.equal(
        multisigIsmAddress,
      );
    });

    it('should read Routing ISM using AleoIsmArtifactManager.readIsm()', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      const readIsm = await artifactManager.readIsm(
        routingIsm.deployed.address,
      );

      expect(readIsm.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(readIsm.deployed.address).to.equal(routingIsm.deployed.address);

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
    });

    it('should verify nested ISM addresses can be read', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      const readRoutingIsm = await artifactManager.readIsm(
        routingIsm.deployed.address,
      );
      const routingConfig =
        readRoutingIsm.config as RawRoutingIsmArtifactConfig;

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

    it('should add a new domain ISM', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      // Add a new domain
      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        { address: string }
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          domains: {
            ...routingIsm.config.domains,
            [DOMAIN_3]: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: testIsmAddress },
            },
          },
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read back and verify
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_3].deployed.address).to.equal(
        testIsmAddress,
      );
      expect(Object.keys(readIsm.config.domains)).to.have.length(3);
    });

    it('should remove a domain ISM', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      // Remove DOMAIN_2
      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        { address: string }
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          domains: {
            [DOMAIN_1]: routingIsm.config.domains[DOMAIN_1],
          },
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read back and verify
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_2]).to.be.undefined;
      expect(Object.keys(readIsm.config.domains)).to.have.length(1);
    });

    it('should update the ISM address for an existing domain', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      // Update DOMAIN_1 to use multisig ISM instead of test ISM
      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        { address: string }
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          domains: {
            [DOMAIN_1]: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: multisigIsmAddress },
            },
            [DOMAIN_2]: routingIsm.config.domains[DOMAIN_2],
          },
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read back and verify
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_1].deployed.address).to.equal(
        multisigIsmAddress,
      );
    });

    it('should transfer ownership of the ISM', async () => {
      const config: RawRoutingIsmArtifactConfig = {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          [DOMAIN_1]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: testIsmAddress },
          },
          [DOMAIN_2]: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: multisigIsmAddress },
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        signer,
      );
      const [routingIsm] = await writer.create({ config });

      // Use a burn address for ownership transfer test
      const burnAddress =
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';

      // Transfer ownership
      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        { address: string }
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          owner: burnAddress,
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read back and verify
      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.owner).to.equal(burnAddress);
    });
  });
});
