import { expect } from 'chai';
import { type Signer, Wallet, ethers } from 'ethers';

import {
  MockSafe__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainMetadata,
  type CoreConfig,
  type DerivedCoreConfig,
  type ProtocolFeeHookConfig,
  TxSubmitterType,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  type Domain,
  ProtocolType,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { runEvmNode } from '../../nodes.js';
import { createMockSafeApi } from '../commands/helpers.js';
import {
  ANVIL_KEY,
  ANVIL_SECONDARY_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

const CORE_READ_CHAIN_2_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
const CORE_READ_CHAIN_3_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_3}/core-config-read.yaml`;

describe('hyperlane core apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CHAIN_2_CONFIG_PATH,
  );
  const hyperlaneCore3 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CHAIN_3_CONFIG_PATH,
  );

  let signer: Signer;
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;
  let startedNodes: { stop: () => Promise<void> }[] = [];

  async function isRpcReady(rpcUrl: string): Promise<boolean> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function deployMockSafeAndTimelock() {
    const provider = signer.provider!;
    const deploySigner = new Wallet(ANVIL_SECONDARY_KEY, provider);
    const deploySignerBalance = await provider.getBalance(deploySigner.address);
    if (deploySignerBalance.lt(ethers.utils.parseEther('10'))) {
      const fundTx = await signer.sendTransaction({
        to: deploySigner.address,
        value: ethers.utils.parseEther('100'),
      });
      await fundTx.wait();
    }
    const mockSafe = await new MockSafe__factory().connect(deploySigner).deploy(
      [initialOwnerAddress],
      1,
    );
    const timelock = await new TimelockController__factory()
      .connect(deploySigner)
      .deploy(
        0,
        [initialOwnerAddress],
        [initialOwnerAddress],
        ethers.constants.AddressZero,
      );
    return { mockSafe, timelock };
  }

  async function deployMockSafeOnly() {
    const provider = signer.provider!;
    const deploySigner = new Wallet(ANVIL_SECONDARY_KEY, provider);
    const deploySignerBalance = await provider.getBalance(deploySigner.address);
    if (deploySignerBalance.lt(ethers.utils.parseEther('10'))) {
      const fundTx = await signer.sendTransaction({
        to: deploySigner.address,
        value: ethers.utils.parseEther('100'),
      });
      await fundTx.wait();
    }
    return new MockSafe__factory().connect(deploySigner).deploy(
      [initialOwnerAddress],
      1,
    );
  }

  before(async () => {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    const chain2RpcUrl = chain2Metadata.rpcUrls[0].http;
    const chain3RpcUrl = chain3Metadata.rpcUrls[0].http;
    if (!(await isRpcReady(chain2RpcUrl))) {
      const chain2RpcPort = parseInt(new URL(chain2RpcUrl).port, 10);
      startedNodes.push(
        await runEvmNode({
          rpcPort: chain2RpcPort,
          chainId: chain2Metadata.chainId,
        } as any),
      );
    }
    if (!(await isRpcReady(chain3RpcUrl))) {
      const chain3RpcPort = parseInt(new URL(chain3RpcUrl).port, 10);
      startedNodes.push(
        await runEvmNode({
          rpcPort: chain3RpcPort,
          chainId: chain3Metadata.chainId,
        } as any),
      );
    }

    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );

    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  after(async () => {
    await Promise.all(startedNodes.map((node) => node.stop()));
    startedNodes = [];
  });

  it('should update the mailbox owner', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    const newOwner = randomAddress().toLowerCase();
    coreConfig.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCore.apply(ANVIL_KEY);
    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
    expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should infer jsonRpc for signer-owned core updates', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    coreConfig.owner = randomAddress().toLowerCase();
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);

    const result = await hyperlaneCore.apply(ANVIL_KEY).nothrow();
    expect(result.exitCode).to.equal(0);
    expect(result.text()).to.include('jsonRpc');
  });

  it('should update the ProxyAdmin to a new one for the mailbox', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const proxyFactory = new ProxyAdmin__factory().connect(signer);
    const deployTx = await proxyFactory.deploy();
    const newProxyAdmin = await deployTx.deployed();
    coreConfig.proxyAdmin!.address = newProxyAdmin.address;

    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCore.apply(ANVIL_KEY);

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
    await hyperlaneCore.deploy(ANVIL_KEY);
    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const newOwner = randomAddress().toLowerCase();
    coreConfig.proxyAdmin!.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCore.apply(ANVIL_KEY);

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
      hyperlaneCore.deploy(ANVIL_KEY),
      hyperlaneCore3.deploy(ANVIL_KEY),
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

    writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfigChain2);
    await hyperlaneCore.apply(ANVIL_KEY);

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
      hyperlaneCore.deploy(ANVIL_KEY),
      hyperlaneCore3.deploy(ANVIL_KEY),
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

    writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfigChain2);
    await hyperlaneCore.apply(ANVIL_KEY);

    const updatedChain2ConfigAfterEnrollment: DerivedCoreConfig =
      await hyperlaneCore.readConfig();
    expect(
      updatedChain2ConfigAfterEnrollment.interchainAccountRouter?.remoteRouters,
    ).to.deep.equal(expectedRemoteRoutersConfigAfterEnrollment);

    // Remove all remote ICAs
    updatedChain2ConfigAfterEnrollment.interchainAccountRouter!.remoteRouters =
      {};
    writeYamlOrJson(
      CORE_READ_CHAIN_2_CONFIG_PATH,
      updatedChain2ConfigAfterEnrollment,
    );

    await hyperlaneCore.apply(ANVIL_KEY);

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

  it('should infer gnosisSafeTxBuilder for safe-owned core updates', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);

    const mockSafe = await new MockSafe__factory()
      .connect(signer)
      .deploy([initialOwnerAddress], 1);
    const safeAddress = mockSafe.address;

    const mockSafeApiServer = await createMockSafeApi(
      readYamlOrJson(CHAIN_2_METADATA_PATH),
      safeAddress,
      initialOwnerAddress,
      5,
    );

    try {
      const configOwnedBySigner: CoreConfig = await hyperlaneCore.readConfig();
      configOwnedBySigner.owner = safeAddress;
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, configOwnedBySigner);
      await hyperlaneCore.apply(ANVIL_KEY);

      const configOwnedBySafe: CoreConfig = await hyperlaneCore.readConfig();
      configOwnedBySafe.owner = randomAddress().toLowerCase();
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, configOwnedBySafe);

      const result = await hyperlaneCore.apply(ANVIL_KEY).nothrow();
      expect(result.exitCode).to.equal(0);
      expect(result.text()).to.include('gnosisSafeTxBuilder');
    } finally {
      await mockSafeApiServer.close();
    }
  });

  it('should still infer gnosisSafeTxBuilder when strategy file lacks chain config', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);

    const mockSafe = await deployMockSafeOnly();
    const safeAddress = mockSafe.address;

    const mockSafeApiServer = await createMockSafeApi(
      readYamlOrJson(CHAIN_2_METADATA_PATH),
      safeAddress,
      initialOwnerAddress,
      5,
    );

    try {
      const configOwnedBySigner: CoreConfig = await hyperlaneCore.readConfig();
      configOwnedBySigner.owner = safeAddress;
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, configOwnedBySigner);
      await hyperlaneCore.apply(ANVIL_KEY);

      const configOwnedBySafe: CoreConfig = await hyperlaneCore.readConfig();
      configOwnedBySafe.owner = randomAddress().toLowerCase();
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, configOwnedBySafe);

      const strategyPath = `${TEMP_PATH}/core-apply-missing-chain-strategy.yaml`;
      writeYamlOrJson(strategyPath, {
        [CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME_3,
          },
        },
      });

      const result = await hyperlaneCore.apply(ANVIL_KEY, strategyPath).nothrow();
      expect(result.exitCode).to.equal(0);
      expect(result.text()).to.include('gnosisSafeTxBuilder');
    } finally {
      await mockSafeApiServer.close();
    }
  });

  it('should route same-chain core txs to multiple inferred submitters', async () => {
    await hyperlaneCore.deploy(ANVIL_KEY);

    const { mockSafe, timelock } = await deployMockSafeAndTimelock();

    const mockSafeApiServer = await createMockSafeApi(
      readYamlOrJson(CHAIN_2_METADATA_PATH),
      mockSafe.address,
      initialOwnerAddress,
      5,
    );

    try {
      const initialConfig: CoreConfig = await hyperlaneCore.readConfig();
      initialConfig.owner = mockSafe.address;
      initialConfig.proxyAdmin = {
        ...initialConfig.proxyAdmin!,
        owner: timelock.address,
      };
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, initialConfig);
      await hyperlaneCore.apply(ANVIL_KEY);

      const mixedOwnerConfig: CoreConfig = await hyperlaneCore.readConfig();
      mixedOwnerConfig.owner = randomAddress().toLowerCase();
      mixedOwnerConfig.proxyAdmin = {
        ...mixedOwnerConfig.proxyAdmin!,
        owner: randomAddress().toLowerCase(),
      };
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, mixedOwnerConfig);

      const result = await hyperlaneCore.apply(ANVIL_KEY).nothrow();
      expect(result.exitCode).to.equal(0);
      expect(result.text()).to.include('gnosisSafeTxBuilder');
      expect(result.text()).to.include('timelockController');
    } finally {
      await mockSafeApiServer.close();
    }
  });

  it('should route same-chain core txs using explicit submitterOverrides strategy', async () => {
    const addresses = await hyperlaneCore.deployOrUseExistingCore(ANVIL_KEY);

    const { mockSafe, timelock } = await deployMockSafeAndTimelock();
    const mockSafeApiServer = await createMockSafeApi(
      readYamlOrJson(CHAIN_2_METADATA_PATH),
      mockSafe.address,
      initialOwnerAddress,
      5,
    );

    try {

      const strategyPath = `${TEMP_PATH}/core-apply-submitter-overrides.yaml`;
      writeYamlOrJson(strategyPath, {
        [CHAIN_NAME_2]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME_2,
          },
          submitterOverrides: {
            [addresses.mailbox]: {
              type: TxSubmitterType.GNOSIS_TX_BUILDER,
              chain: CHAIN_NAME_2,
              safeAddress: mockSafe.address,
              version: '1.0',
            },
            [addresses.proxyAdmin!]: {
              type: TxSubmitterType.TIMELOCK_CONTROLLER,
              chain: CHAIN_NAME_2,
              timelockAddress: timelock.address,
              proposerSubmitter: {
                type: TxSubmitterType.JSON_RPC,
                chain: CHAIN_NAME_2,
              },
            },
          },
        },
      });

      const config: CoreConfig = await hyperlaneCore.readConfig();
      config.owner = randomAddress().toLowerCase();
      config.proxyAdmin = {
        ...config.proxyAdmin!,
        owner: randomAddress().toLowerCase(),
      };
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, config);

      const result = await hyperlaneCore.apply(ANVIL_KEY, strategyPath).nothrow();
      expect(result.exitCode).to.equal(0);
      expect(result.text()).to.include('gnosisSafeTxBuilder');
      expect(result.text()).to.include('timelockController');
    } finally {
      await mockSafeApiServer.close();
    }
  });

  it('should route core apply using uppercase 0X override target keys', async () => {
    const addresses = await hyperlaneCore.deployOrUseExistingCore(ANVIL_KEY);
    const mailboxUpperPrefix = `0X${addresses.mailbox.slice(2)}`;

    const mockSafe = await deployMockSafeOnly();
    const mockSafeApiServer = await createMockSafeApi(
      readYamlOrJson(CHAIN_2_METADATA_PATH),
      mockSafe.address,
      initialOwnerAddress,
      5,
    );

    try {
      const strategyPath = `${TEMP_PATH}/core-apply-submitter-overrides-upper-prefix.yaml`;
      writeYamlOrJson(strategyPath, {
        [CHAIN_NAME_2]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME_2,
          },
          submitterOverrides: {
            [mailboxUpperPrefix]: {
              type: TxSubmitterType.GNOSIS_TX_BUILDER,
              chain: CHAIN_NAME_2,
              safeAddress: mockSafe.address,
              version: '1.0',
            },
          },
        },
      });

      const config: CoreConfig = await hyperlaneCore.readConfig();
      config.owner = randomAddress().toLowerCase();
      writeYamlOrJson(CORE_READ_CONFIG_PATH_2, config);

      const result = await hyperlaneCore.apply(ANVIL_KEY, strategyPath).nothrow();
      expect(result.exitCode).to.equal(0);
      expect(result.text()).to.include('gnosisSafeTxBuilder');
    } finally {
      await mockSafeApiServer.close();
    }
  });

  it('should prioritize selector-specific override over target-only override for core apply', async () => {
    const addresses = await hyperlaneCore.deployOrUseExistingCore(ANVIL_KEY);

    const { mockSafe, timelock } = await deployMockSafeAndTimelock();

    const strategyPath = `${TEMP_PATH}/core-apply-selector-overrides.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN_NAME_2]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_NAME_2,
        },
        submitterOverrides: {
          [addresses.mailbox]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN_NAME_2,
            safeAddress: mockSafe.address,
            version: '1.0',
          },
          [`${addresses.mailbox}@0xf2fde38b`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN_NAME_2,
            timelockAddress: timelock.address,
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN_NAME_2,
            },
          },
        },
      },
    });

    const config: CoreConfig = await hyperlaneCore.readConfig();
    config.owner = randomAddress().toLowerCase();
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, config);

    const result = await hyperlaneCore.apply(ANVIL_KEY, strategyPath).nothrow();
    expect(result.exitCode).to.equal(0);
    expect(result.text()).to.include('timelockController');
    expect(result.text()).to.not.include('gnosisSafeTxBuilder');
  });

  it('should match selector-specific override with uppercase 0X selector prefix for core apply', async () => {
    const addresses = await hyperlaneCore.deployOrUseExistingCore(ANVIL_KEY);

    const { mockSafe, timelock } = await deployMockSafeAndTimelock();

    const strategyPath = `${TEMP_PATH}/core-apply-selector-overrides-upper-prefix.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN_NAME_2]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_NAME_2,
        },
        submitterOverrides: {
          [addresses.mailbox]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN_NAME_2,
            safeAddress: mockSafe.address,
            version: '1.0',
          },
          [`${addresses.mailbox}@0XF2FDE38B`]: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN_NAME_2,
            timelockAddress: timelock.address,
            proposerSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: CHAIN_NAME_2,
            },
          },
        },
      },
    });

    const config: CoreConfig = await hyperlaneCore.readConfig();
    config.owner = randomAddress().toLowerCase();
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, config);

    const result = await hyperlaneCore.apply(ANVIL_KEY, strategyPath).nothrow();
    expect(result.exitCode).to.equal(0);
    expect(result.text()).to.include('timelockController');
    expect(result.text()).to.not.include('gnosisSafeTxBuilder');
  });
});
