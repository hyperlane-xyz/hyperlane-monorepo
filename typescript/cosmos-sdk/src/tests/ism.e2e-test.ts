import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type IsmType,
  type MultisigIsmConfig,
  type RawIsmArtifactConfig,
  type RawRoutingIsmArtifactConfig,
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert, normalizeConfig } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { CosmosIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createSigner } from '../testing/utils.js';

describe('Cosmos ISM Artifact API (e2e)', function () {
  this.timeout(100_000);

  let cosmosSigner: CosmosNativeSigner;
  let signer: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: CosmosIsmArtifactManager;

  before(async () => {
    cosmosSigner = await createSigner('alice');
    signer = cosmosSigner;

    const [rpc, ...otherRpcUrls] = cosmosSigner.getRpcUrls();
    assert(rpc, 'At least one rpc is required');

    artifactManager = new CosmosIsmArtifactManager([rpc, ...otherRpcUrls]);
  });

  describe('Non composite ISMs', () => {
    const validators = [
      '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
      '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
      '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
    ];

    const testCases: Array<{
      name: string;
      type: IsmType;
      config: TestIsmConfig | MultisigIsmConfig;
      verifyConfig?: (config: RawIsmArtifactConfig) => void;
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
        verifyConfig: (config) => {
          expect(normalizeConfig(config)).to.deep.equal(
            normalizeConfig({
              type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
              validators,
              threshold: 2,
            }),
          );
        },
      },
      {
        name: 'MerkleRoot Multisig ISM',
        type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        config: {
          type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
          validators,
          threshold: 2,
        },
        verifyConfig: (config) => {
          expect(normalizeConfig(config)).to.deep.equal(
            normalizeConfig({
              type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
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
          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [result, receipts] = await writer.create({ config });

          expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(result.config.type).to.equal(type);
          expect(result.deployed.address).to.be.a('string').and.not.be.empty;
          expect(receipts).to.be.an('array').with.length.greaterThan(0);
        });

        it(`should read a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, cosmosSigner);
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

        it('should return no transactions when calling update', async () => {
          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedIsm] = await writer.create({ config });

          const txs = await writer.update(deployedIsm);
          expect(txs).to.be.an('array').with.length(0);
        });
      });
    });
  });

  describe(AltVM.IsmType.ROUTING, () => {
    let testIsmAddress: string;
    let multisigIsmAddress: string;

    const DOMAIN_1 = 42;
    const DOMAIN_2 = 96;
    const DOMAIN_3 = 100;

    let config: RawRoutingIsmArtifactConfig;
    let routingIsmWriter: ArtifactWriter<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >;

    before(async () => {
      const testWriter = artifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [testIsm] = await testWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });
      testIsmAddress = testIsm.deployed.address;

      const multisigWriter = artifactManager.createWriter(
        AltVM.IsmType.MESSAGE_ID_MULTISIG,
        cosmosSigner,
      );
      const [multisigIsm] = await multisigWriter.create({
        config: {
          type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
          validators: ['0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c'],
          threshold: 1,
        },
      });
      multisigIsmAddress = multisigIsm.deployed.address;

      config = {
        type: AltVM.IsmType.ROUTING,
        owner: cosmosSigner.getSignerAddress(),
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

      routingIsmWriter = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        cosmosSigner,
      );
    });

    it('should create and read the provided config', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);

      expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(readIsm.config.owner).to.equal(cosmosSigner.getSignerAddress());
      expect(Object.keys(readIsm.config.domains)).to.have.length(2);
      expect(readIsm.config.domains[DOMAIN_1].deployed.address).to.equal(
        testIsmAddress,
      );
      expect(readIsm.config.domains[DOMAIN_2].deployed.address).to.equal(
        multisigIsmAddress,
      );
    });

    it('should add a new domain ISM', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        DeployedIsmAddress
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

      const txs = await routingIsmWriter.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await signer.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_3].deployed.address).to.equal(
        testIsmAddress,
      );
      expect(Object.keys(readIsm.config.domains)).to.have.length(3);
    });

    it('should remove a domain ISM', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        DeployedIsmAddress
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          domains: {
            [DOMAIN_1]: routingIsm.config.domains[DOMAIN_1],
          },
        },
      };

      const txs = await routingIsmWriter.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await signer.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_2]).to.be.undefined;
      expect(Object.keys(readIsm.config.domains)).to.have.length(1);
    });

    it('should update the ISM address for an existing domain', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const testWriter = artifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [freshIsm] = await testWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        DeployedIsmAddress
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          domains: {
            [DOMAIN_1]: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: freshIsm.deployed.address },
            },
            [DOMAIN_2]: routingIsm.config.domains[DOMAIN_2],
          },
        },
      };

      const txs = await routingIsmWriter.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await signer.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_1].deployed.address).to.equal(
        freshIsm.deployed.address,
      );
    });

    it('should transfer ownership of the ISM', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const bobSigner = await createSigner('bob');

      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        DeployedIsmAddress
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          owner: bobSigner.getSignerAddress(),
        },
      };

      const txs = await routingIsmWriter.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await signer.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.owner).to.equal(bobSigner.getSignerAddress());
    });
  });
});
