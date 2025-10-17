import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  ChainMetadata,
  CoreConfig,
  DerivedCoreConfig,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  Domain,
  ProtocolType,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';

describe('hyperlane core apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const hyperlaneCore3 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  let signer: Signer;
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;

  before(async () => {
    const chain2Metadata: ChainMetadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const chain3Metadata: ChainMetadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );

    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const wallet = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  it('should update the mailbox owner', async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    const newOwner = randomAddress().toLowerCase();
    coreConfig.owner = newOwner;
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfig,
    );
    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);
    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
    expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should update the ProxyAdmin to a new one for the mailbox', async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const proxyFactory = new ProxyAdmin__factory().connect(signer);
    const deployTx = await proxyFactory.deploy();
    const newProxyAdmin = await deployTx.deployed();
    coreConfig.proxyAdmin!.address = newProxyAdmin.address;

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfig,
    );
    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(updatedConfig.owner).to.equal(initialOwnerAddress);
    expect(updatedConfig.proxyAdmin?.address).to.equal(newProxyAdmin.address);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should update the ProxyAdmin owner for the mailbox', async () => {
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const newOwner = randomAddress().toLowerCase();
    coreConfig.proxyAdmin!.owner = newOwner;
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfig,
    );
    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(updatedConfig.owner).to.equal(initialOwnerAddress);
    expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should enroll a remote ICA Router and update the config on all involved chains', async () => {
    await Promise.all([
      hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum),
      hyperlaneCore3.deploy(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    const [coreConfigChain2, coreConfigChain3]: DerivedCoreConfig[] =
      await Promise.all([
        hyperlaneCore.readConfig(),
        hyperlaneCore3.readConfig(),
      ]);

    expect(coreConfigChain2.owner).to.equal(initialOwnerAddress);
    expect(coreConfigChain3.owner).to.equal(initialOwnerAddress);

    expect(coreConfigChain2.interchainAccountRouter).not.to.be.undefined;
    expect(coreConfigChain3.interchainAccountRouter).not.to.be.undefined;

    const coreConfigChain2IcaConfig = coreConfigChain2.interchainAccountRouter!;
    const coreConfigChain3IcaConfig = coreConfigChain3.interchainAccountRouter!;

    // Add the remote ica on chain anvil3
    coreConfigChain2IcaConfig.remoteRouters = {
      [chain3DomainId]: {
        address: coreConfigChain3IcaConfig.address,
      },
    };

    const expectedChain2RemoteRoutersConfig = {
      [chain3DomainId]: {
        address: addressToBytes32(coreConfigChain3IcaConfig.address),
      },
    };

    const expectedChain3RemoteRoutersConfig = {
      [chain2DomainId]: {
        address: addressToBytes32(coreConfigChain2IcaConfig.address),
      },
    };

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfigChain2,
    );
    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    const [updatedChain2Config, updatedChain3Config]: DerivedCoreConfig[] =
      await Promise.all([
        hyperlaneCore.readConfig(),
        hyperlaneCore3.readConfig(),
      ]);
    expect(
      updatedChain2Config.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal(expectedChain2RemoteRoutersConfig);

    expect(
      updatedChain3Config.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal(expectedChain3RemoteRoutersConfig);
  });

  it('should unenroll a remote ICA Router and update the config on all involved chains', async () => {
    await Promise.all([
      hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.ethereum),
      hyperlaneCore3.deploy(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    const [coreConfigChain2, coreConfigChain3]: DerivedCoreConfig[] =
      await Promise.all([
        hyperlaneCore.readConfig(),
        hyperlaneCore3.readConfig(),
      ]);

    expect(coreConfigChain2.interchainAccountRouter).not.to.be.undefined;
    expect(coreConfigChain3.interchainAccountRouter).not.to.be.undefined;

    const coreConfigChain2IcaConfig = coreConfigChain2.interchainAccountRouter!;
    const coreConfigChain3IcaConfig = coreConfigChain3.interchainAccountRouter!;

    coreConfigChain2IcaConfig.remoteRouters = {
      [chain3DomainId]: {
        address: coreConfigChain3IcaConfig.address,
      },
    };

    const expectedRemoteRoutersConfigAfterEnrollment = {
      [chain3DomainId]: {
        address: addressToBytes32(coreConfigChain3IcaConfig.address),
      },
    };

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfigChain2,
    );
    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    const updatedChain2ConfigAfterEnrollment: DerivedCoreConfig =
      await hyperlaneCore.readConfig();
    expect(
      updatedChain2ConfigAfterEnrollment.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal(expectedRemoteRoutersConfigAfterEnrollment);

    // Remove all remote ICAs
    updatedChain2ConfigAfterEnrollment.interchainAccountRouter!.remoteRouters =
      {};
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      updatedChain2ConfigAfterEnrollment,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    const [updatedChain2Config, updatedChain3Config]: DerivedCoreConfig[] =
      await Promise.all([
        hyperlaneCore.readConfig(),
        hyperlaneCore3.readConfig(),
      ]);

    expect(
      updatedChain2Config.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal({});

    expect(
      updatedChain3Config.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal({});
  });
});
