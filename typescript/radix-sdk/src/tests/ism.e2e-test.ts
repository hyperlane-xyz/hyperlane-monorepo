import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  IsmType,
  MultisigIsmConfig,
  RawRoutingIsmArtifactConfig,
  TestIsmConfig,
  ismOnChainAddress,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert, normalizeConfig } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';
import { RadixIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

describe('Radix ISMs (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixSigner: RadixSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: RadixIsmArtifactManager;

  before(async () => {
    const rpcUrls =
      DEPLOYED_TEST_CHAIN_METADATA.rpcUrls?.map((url) => url.http) ?? [];
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

    radixSigner = (await RadixSigner.connectWithSigner(
      rpcUrls,
      TEST_RADIX_PRIVATE_KEY,
      {
        metadata: {
          chainId: DEPLOYED_TEST_CHAIN_METADATA.chainId,
          gatewayUrls: DEPLOYED_TEST_CHAIN_METADATA.gatewayUrls,
          packageAddress: DEPLOYED_TEST_CHAIN_METADATA.packageAddress,
        },
      },
    )) as RadixSigner;

    providerSdkSigner = radixSigner;

    const gateway = (radixSigner as any).gateway;
    const base = (radixSigner as any).base;
    artifactManager = new RadixIsmArtifactManager(gateway, base);
  });

  describe('Non composite ISMs', () => {
    const validators = [
      '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
      '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
      '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
    ];

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
      {
        name: 'MerkleRoot Multisig ISM',
        type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        config: {
          type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
          validators,
          threshold: 2,
        },
        verifyConfig: (config: MultisigIsmConfig) => {
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
          const writer = artifactManager.createWriter(type, radixSigner);
          const [result, receipts] = await writer.create({ config });

          expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(result.config.type).to.equal(type);
          expect(result.deployed.address).to.be.a('string').and.not.be.empty;
          expect(receipts).to.be.an('array').with.length.greaterThan(0);
        });

        it(`should read a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, radixSigner);
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
          const writer = artifactManager.createWriter(type, radixSigner);

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
        radixSigner,
      );

      const [testIsm] = await testWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });
      testIsmAddress = testIsm.deployed.address;

      const multisigWriter = artifactManager.createWriter(
        AltVM.IsmType.MESSAGE_ID_MULTISIG,
        radixSigner,
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
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
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
        radixSigner,
      );
    });

    it('should create and read the provided config', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);

      expect(readIsm.config.type).to.equal(AltVM.IsmType.ROUTING);
      expect(readIsm.config.owner).to.equal(TEST_RADIX_DEPLOYER_ADDRESS);
      expect(Object.keys(readIsm.config.domains)).to.have.length(2);
      expect(ismOnChainAddress(readIsm.config.domains[DOMAIN_1])).to.equal(
        testIsmAddress,
      );
      expect(ismOnChainAddress(readIsm.config.domains[DOMAIN_2])).to.equal(
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
      expect(txs[0].annotation).to.include(`domain ${DOMAIN_3}`);

      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(ismOnChainAddress(readIsm.config.domains[DOMAIN_3])).to.equal(
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

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        radixSigner,
      );
      const txs = await writer.update(updatedConfig);

      expect(txs).to.be.an('array').with.length.greaterThan(0);
      const removeTx = txs.find((tx) => tx.annotation?.includes('Remove'));
      expect(removeTx).to.exist;

      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(readIsm.config.domains[DOMAIN_2]).to.be.undefined;
      expect(Object.keys(readIsm.config.domains)).to.have.length(1);
    });

    it('should update the ISM address for an existing domain', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

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
              deployed: { address: multisigIsmAddress },
            },
            [DOMAIN_2]: routingIsm.config.domains[DOMAIN_2],
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        radixSigner,
      );
      const txs = await writer.update(updatedConfig);

      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);
      expect(ismOnChainAddress(readIsm.config.domains[DOMAIN_1])).to.equal(
        multisigIsmAddress,
      );
    });

    it('should transfer ownership of the ISM', async () => {
      const [routingIsm] = await routingIsmWriter.create({ config });

      const updatedConfig: ArtifactDeployed<
        RawRoutingIsmArtifactConfig,
        DeployedIsmAddress
      > = {
        ...routingIsm,
        config: {
          ...routingIsm.config,
          owner: TEST_RADIX_BURN_ADDRESS,
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        radixSigner,
      );
      const txs = await writer.update(updatedConfig);

      expect(txs).to.be.an('array').with.length.greaterThan(0);

      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
      const readIsm = await reader.read(routingIsm.deployed.address);

      expect(readIsm.config.owner).to.equal(TEST_RADIX_BURN_ADDRESS);
    });
  });
});
