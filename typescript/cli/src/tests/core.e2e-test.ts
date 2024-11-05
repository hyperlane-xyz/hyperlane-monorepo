import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  CoreConfig,
  DerivedCoreConfig,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, Domain, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  hyperlaneCoreApply,
  hyperlaneCoreDeploy,
  readCoreConfig,
} from './commands/core.js';
import { ANVIL_KEY, REGISTRY_PATH } from './commands/helpers.js';

const CHAIN_NAME_2 = 'anvil2';
const CHAIN_NAME_3 = 'anvil3';

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;

const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh
const CORE_READ_CHAIN_2_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
const CORE_READ_CHAIN_3_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_3}/core-config-read.yaml`;

const TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while
describe('hyperlane core e2e tests', async function () {
  this.timeout(TEST_TIMEOUT);

  let signer: Signer;
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;

  before(async () => {
    const chain2Metadata: any = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );

    const chain3Metadata: any = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`,
    );

    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );

    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  describe('core.deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);

      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );

      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((coreConfig.requiredHook as ProtocolFeeHookConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });

    it('should create a core deployment with the mailbox owner set to the address in the config', async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

      const newOwner = randomAddress().toLowerCase();

      coreConfig.owner = newOwner;
      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );

      expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
      expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });

    it('should create a core deployment with ProxyAdmin owner of the mailbox set to the address in the config', async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

      const newOwner = randomAddress().toLowerCase();

      coreConfig.proxyAdmin = { owner: newOwner };
      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );

      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });
  });

  describe('core.apply', () => {
    it('should update the mailbox owner', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      const newOwner = randomAddress().toLowerCase();
      coreConfig.owner = newOwner;
      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfig);
      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);
      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
      expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });

    it('should update the ProxyAdmin to a new one for the mailbox', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);

      const proxyFactory = new ProxyAdmin__factory().connect(signer);
      const deployTx = await proxyFactory.deploy();
      const newProxyAdmin = await deployTx.deployed();
      coreConfig.proxyAdmin!.address = newProxyAdmin.address;

      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfig);
      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.address).to.equal(newProxyAdmin.address);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });

    it('should update the ProxyAdmin owner for the mailbox', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);

      const newOwner = randomAddress().toLowerCase();
      coreConfig.proxyAdmin!.owner = newOwner;
      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfig);
      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });

    it('should enroll a remote ICA Router and update the config on all involved chains', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
      await hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH);

      const coreConfigChain2: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      const coreConfigChain3: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_3,
        CORE_READ_CHAIN_3_CONFIG_PATH,
      );
      expect(coreConfigChain2.owner).to.equal(initialOwnerAddress);
      expect(coreConfigChain3.owner).to.equal(initialOwnerAddress);

      // Add the remote ica on chain anvil3
      coreConfigChain2.interchainAccountRouter.remoteIcaRouters = {
        [chain3DomainId]: {
          address: coreConfigChain3.interchainAccountRouter.address,
        },
      };

      const expectedChain2RemoteRoutersConfig = {
        [chain3DomainId]: {
          address: addressToBytes32(
            coreConfigChain3.interchainAccountRouter.address,
          ),
        },
      };

      const expectedChain3RemoteRoutersConfig = {
        [chain2DomainId]: {
          address: addressToBytes32(
            coreConfigChain2.interchainAccountRouter.address,
          ),
        },
      };

      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfigChain2);
      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      const updatedChain2Config: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(
        updatedChain2Config.interchainAccountRouter.remoteIcaRouters,
      ).to.deep.equal(expectedChain2RemoteRoutersConfig);

      const updatedChain3Config: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_3,
        CORE_READ_CHAIN_3_CONFIG_PATH,
      );
      expect(
        updatedChain3Config.interchainAccountRouter.remoteIcaRouters,
      ).to.deep.equal(expectedChain3RemoteRoutersConfig);
    });

    it('should unenroll a remote ICA Router and update the config on all involved chains', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
      await hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH);

      const coreConfigChain2: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      const coreConfigChain3: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_3,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );

      coreConfigChain2.interchainAccountRouter.remoteIcaRouters = {
        [chain3DomainId]: {
          address: coreConfigChain3.interchainAccountRouter.address,
        },
      };

      const expectedRemoteRoutersConfigAfterEnrollment = {
        [chain3DomainId]: {
          address: addressToBytes32(
            coreConfigChain3.interchainAccountRouter.address,
          ),
        },
      };

      writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfigChain2);
      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      const updatedChain2ConfigAfterEnrollment: DerivedCoreConfig =
        await readCoreConfig(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);
      expect(
        updatedChain2ConfigAfterEnrollment.interchainAccountRouter
          .remoteIcaRouters,
      ).to.deep.equal(expectedRemoteRoutersConfigAfterEnrollment);

      // Remove all remote ICAs
      updatedChain2ConfigAfterEnrollment.interchainAccountRouter.remoteIcaRouters =
        {};
      writeYamlOrJson(
        CORE_READ_CHAIN_2_CONFIG_PATH,
        updatedChain2ConfigAfterEnrollment,
      );

      await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

      const updatedChain2Config: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(
        updatedChain2Config.interchainAccountRouter.remoteIcaRouters,
      ).to.deep.equal({});

      const updatedChain3Config: DerivedCoreConfig = await readCoreConfig(
        CHAIN_NAME_3,
        CORE_READ_CHAIN_2_CONFIG_PATH,
      );
      expect(
        updatedChain3Config.interchainAccountRouter.remoteIcaRouters,
      ).to.deep.equal({});
    });
  });
});
