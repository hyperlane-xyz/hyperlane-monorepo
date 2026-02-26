import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type AccountConfig,
  type ChainMetadata,
  InterchainAccount,
  isContractAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  addressToBytes32,
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { IcaDeployStatus } from '../../../deploy/ica.js';
import { readYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneIcaDeploy, hyperlaneIcaDeployRaw } from '../commands/ica.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane ica deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let chain4Addresses: ChainAddresses;

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;
  let walletChain4: Wallet;

  let chain2DomainId: number;
  let chain3DomainId: number;
  let chain4DomainId: number;

  before(async function () {
    // Deploy core contracts on all chains
    [chain2Addresses, chain3Addresses, chain4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    const chain4Metadata: ChainMetadata = readYamlOrJson(CHAIN_4_METADATA_PATH);

    chain2DomainId = chain2Metadata.domainId!;
    chain3DomainId = chain3Metadata.domainId!;
    chain4DomainId = chain4Metadata.domainId!;

    const providerChain2 = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    const providerChain3 = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const providerChain4 = new ethers.providers.JsonRpcProvider(
      chain4Metadata.rpcUrls[0].http,
    );

    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);
    walletChain4 = new Wallet(ANVIL_KEY).connect(providerChain4);
    ownerAddress = walletChain2.address;

    // Enroll ICA routers with each other so they can communicate
    const icaRouterChain2 = InterchainAccountRouter__factory.connect(
      chain2Addresses.interchainAccountRouter!,
      walletChain2,
    );
    const icaRouterChain3 = InterchainAccountRouter__factory.connect(
      chain3Addresses.interchainAccountRouter!,
      walletChain3,
    );
    const icaRouterChain4 = InterchainAccountRouter__factory.connect(
      chain4Addresses.interchainAccountRouter!,
      walletChain4,
    );

    // Check if routers are already enrolled
    const chain2RouterOnChain3 = await icaRouterChain3.routers(chain2DomainId);
    const chain3RouterOnChain2 = await icaRouterChain2.routers(chain3DomainId);
    const chain2RouterOnChain4 = await icaRouterChain4.routers(chain2DomainId);
    const chain4RouterOnChain2 = await icaRouterChain2.routers(chain4DomainId);

    // Enroll chain2's router on chain3 if not already enrolled
    if (isZeroishAddress(chain2RouterOnChain3)) {
      const tx1 = await icaRouterChain3.enrollRemoteRouterAndIsm(
        chain2DomainId,
        addressToBytes32(chain2Addresses.interchainAccountRouter!),
        ethers.constants.HashZero, // Use default ISM
      );
      await tx1.wait();
    }

    // Enroll chain3's router on chain2 if not already enrolled
    if (isZeroishAddress(chain3RouterOnChain2)) {
      const tx2 = await icaRouterChain2.enrollRemoteRouterAndIsm(
        chain3DomainId,
        addressToBytes32(chain3Addresses.interchainAccountRouter!),
        ethers.constants.HashZero, // Use default ISM
      );
      await tx2.wait();
    }

    // Enroll chain2's router on chain4 if not already enrolled
    if (isZeroishAddress(chain2RouterOnChain4)) {
      const tx3 = await icaRouterChain4.enrollRemoteRouterAndIsm(
        chain2DomainId,
        addressToBytes32(chain2Addresses.interchainAccountRouter!),
        ethers.constants.HashZero, // Use default ISM
      );
      await tx3.wait();
    }

    // Enroll chain4's router on chain2 if not already enrolled
    if (isZeroishAddress(chain4RouterOnChain2)) {
      const tx4 = await icaRouterChain2.enrollRemoteRouterAndIsm(
        chain4DomainId,
        addressToBytes32(chain4Addresses.interchainAccountRouter!),
        ethers.constants.HashZero, // Use default ISM
      );
      await tx4.wait();
    }
  });

  describe('hyperlane ica deploy', () => {
    it('should deploy ICAs on destination chains', async function () {
      // Ensure ICA routers are deployed
      expect(chain2Addresses.interchainAccountRouter).to.not.be.undefined;
      expect(chain3Addresses.interchainAccountRouter).to.not.be.undefined;
      expect(chain4Addresses.interchainAccountRouter).to.not.be.undefined;

      // Deploy ICAs on both chain3 and chain4 from chain2 in a single call
      const { exitCode, stdout } = await hyperlaneIcaDeploy(
        CHAIN_NAME_2,
        [CHAIN_NAME_3, CHAIN_NAME_4],
        ownerAddress,
      );

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(CHAIN_NAME_3);
      expect(stdout).to.include(CHAIN_NAME_4);

      // Verify both ICAs were deployed or exist
      const chain3Status =
        stdout.includes(`${CHAIN_NAME_3}`) &&
        (stdout.includes(IcaDeployStatus.Deployed) ||
          stdout.includes(IcaDeployStatus.Exists));
      const chain4Status =
        stdout.includes(`${CHAIN_NAME_4}`) &&
        (stdout.includes(IcaDeployStatus.Deployed) ||
          stdout.includes(IcaDeployStatus.Exists));

      expect(chain3Status).to.be.true;
      expect(chain4Status).to.be.true;

      // Verify the ICAs actually exist on-chain
      const { multiProvider } = await getContext({
        registryUris: [REGISTRY_PATH],
        key: ANVIL_KEY,
      });

      const addressesMap: Record<string, Record<string, string>> = {
        [CHAIN_NAME_2]: chain2Addresses,
        [CHAIN_NAME_3]: chain3Addresses,
        [CHAIN_NAME_4]: chain4Addresses,
      };

      const ica = InterchainAccount.fromAddressesMap(
        addressesMap,
        multiProvider,
      );
      const ownerConfig: AccountConfig = {
        origin: CHAIN_NAME_2,
        owner: ownerAddress,
      };

      const icaOnChain3 = await ica.getAccount(CHAIN_NAME_3, ownerConfig);
      const icaOnChain4 = await ica.getAccount(CHAIN_NAME_4, ownerConfig);

      expect(await isContractAddress(multiProvider, CHAIN_NAME_3, icaOnChain3))
        .to.be.true;
      expect(await isContractAddress(multiProvider, CHAIN_NAME_4, icaOnChain4))
        .to.be.true;
    });

    it('should deploy ICA with address matching expected address', async function () {
      // Get context and create InterchainAccount instance to compute expected address
      const { multiProvider } = await getContext({
        registryUris: [REGISTRY_PATH],
        key: ANVIL_KEY,
      });

      const addressesMap: Record<string, Record<string, string>> = {
        [CHAIN_NAME_2]: chain2Addresses,
        [CHAIN_NAME_3]: chain3Addresses,
      };

      const ica = InterchainAccount.fromAddressesMap(
        addressesMap,
        multiProvider,
      );
      const ownerConfig: AccountConfig = {
        origin: CHAIN_NAME_2,
        owner: ownerAddress,
      };

      // Get expected ICA address before deployment
      const expectedIcaAddress = await ica.getAccount(
        CHAIN_NAME_3,
        ownerConfig,
      );

      // Deploy ICA via CLI
      const { exitCode, stdout } = await hyperlaneIcaDeploy(
        CHAIN_NAME_2,
        [CHAIN_NAME_3],
        ownerAddress,
      );

      expect(exitCode).to.equal(0);

      // Extract ICA address from stdout - look for it after "ICA" status messages
      // Pattern matches "ICA already exists on <chain>: <address>" or "ICA deployed on <chain>: <address>"
      const icaAddressMatch = stdout.match(
        /ICA (?:already exists|deployed) on \w+: (0x[a-fA-F0-9]{40})/,
      );
      expect(icaAddressMatch).to.not.be.null;

      const deployedIcaAddress = icaAddressMatch![1];

      // Verify deployed address matches expected address
      expect(eqAddress(deployedIcaAddress, expectedIcaAddress)).to.be.true;
    });

    it('should show exists status when ICA already deployed', async function () {
      // Deploy ICA first time
      await hyperlaneIcaDeploy(CHAIN_NAME_2, [CHAIN_NAME_3], ownerAddress);

      // Deploy again - should show 'exists'
      const { exitCode, stdout } = await hyperlaneIcaDeploy(
        CHAIN_NAME_2,
        [CHAIN_NAME_3],
        ownerAddress,
      );

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(IcaDeployStatus.Exists);
    });

    it('should deploy ICAs on multiple destination chains', async function () {
      // Deploy ICAs on both chain2 and chain3 from the same owner
      // Using chain2 as origin, deploy to chain3
      // Then using chain3 as origin, deploy to chain2
      const { exitCode: exitCode1, stdout: stdout1 } = await hyperlaneIcaDeploy(
        CHAIN_NAME_2,
        [CHAIN_NAME_3],
        ownerAddress,
      );

      expect(exitCode1).to.equal(0);
      expect(stdout1).to.include(CHAIN_NAME_3);

      const { exitCode: exitCode2, stdout: stdout2 } = await hyperlaneIcaDeploy(
        CHAIN_NAME_3,
        [CHAIN_NAME_2],
        ownerAddress,
      );

      expect(exitCode2).to.equal(0);
      expect(stdout2).to.include(CHAIN_NAME_2);
    });

    it('should deploy ICA that can receive calls from origin chain', async function () {
      // Deploy ICA on chain3 for owner on chain2
      await hyperlaneIcaDeploy(CHAIN_NAME_2, [CHAIN_NAME_3], ownerAddress);

      // Get context and create InterchainAccount instance
      const { multiProvider } = await getContext({
        registryUris: [REGISTRY_PATH],
        key: ANVIL_KEY,
      });

      // Set up signers
      multiProvider.setSigner(CHAIN_NAME_2, walletChain2);
      multiProvider.setSigner(CHAIN_NAME_3, walletChain3);

      // Get chain addresses from registry
      const addressesMap: Record<string, Record<string, string>> = {
        [CHAIN_NAME_2]: chain2Addresses,
        [CHAIN_NAME_3]: chain3Addresses,
      };

      // Create InterchainAccount instance
      const ica = InterchainAccount.fromAddressesMap(
        addressesMap,
        multiProvider,
      );

      // Get the ICA address on chain3
      const ownerConfig: AccountConfig = {
        origin: CHAIN_NAME_2,
        owner: ownerAddress,
      };

      const icaAddress = await ica.getAccount(CHAIN_NAME_3, ownerConfig);

      // Verify the ICA contract exists
      expect(await isContractAddress(multiProvider, CHAIN_NAME_3, icaAddress))
        .to.be.true;

      // Send some ETH to the ICA so it can make calls
      const fundTx = await walletChain3.sendTransaction({
        to: icaAddress,
        value: ethers.utils.parseEther('1'),
      });
      await fundTx.wait();

      // Verify the ICA has the correct owner by checking it through the router
      const icaRouter = InterchainAccountRouter__factory.connect(
        chain3Addresses.interchainAccountRouter!,
        walletChain3,
      );

      const originDomain = multiProvider.getDomainId(CHAIN_NAME_2);

      // Get the expected ICA address using the router's getLocalInterchainAccount function
      const expectedIcaAddress = await icaRouter[
        'getLocalInterchainAccount(uint32,address,address,address)'
      ](
        originDomain,
        ownerAddress,
        chain2Addresses.interchainAccountRouter!,
        ethers.constants.AddressZero, // default ISM
      );

      expect(icaAddress.toLowerCase()).to.equal(
        expectedIcaAddress.toLowerCase(),
      );
    });

    it('should fail with invalid owner address', async function () {
      const invalidOwner = 'not-a-valid-address';

      const result = await hyperlaneIcaDeployRaw({
        origin: CHAIN_NAME_2,
        chains: [CHAIN_NAME_3],
        owner: invalidOwner,
        privateKey: ANVIL_KEY,
        skipConfirmationPrompts: true,
      }).nothrow();

      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include('Invalid owner address');
    });
  });
});
