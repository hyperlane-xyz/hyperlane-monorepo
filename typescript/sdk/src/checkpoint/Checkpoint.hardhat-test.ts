import { expect } from 'chai';
import { Signer } from 'ethers';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  CheckpointStorage,
  CheckpointStorage__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { CheckpointModule } from './CheckpointModule.js';

describe('CheckpointModule', async () => {
  const chain = TestChainName.test1;

  let multiProvider: MultiProvider;
  let coreAddresses: CoreAddresses;
  let signer: Signer;
  let checkpointModule: CheckpointModule;
  let checkpointStorage: CheckpointStorage;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );

    // legacy HyperlaneIsmFactory is required to do a core deploy
    const legacyIsmFactory = new HyperlaneIsmFactory(
      contractsMap,
      multiProvider,
    );

    // core deployer for tests
    const testCoreDeployer = new TestCoreDeployer(
      multiProvider,
      legacyIsmFactory,
    );

    // mailbox and proxy admin for the core deploy
    const { mailbox, proxyAdmin, validatorAnnounce } = (
      await testCoreDeployer.deployApp()
    ).getContracts(chain);

    coreAddresses = {
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounce.address,
    };
  });

  beforeEach(async () => {
    // Create a new CheckpointModule before each test
    checkpointModule = await CheckpointModule.create({
      chain,
      config: { chain },
      coreAddresses: { mailbox: coreAddresses.mailbox },
      multiProvider,
    });

    // Get the deployed checkpoint storage contract
    const deployedAddress = (checkpointModule as any).args.addresses
      .checkpointStorage;
    checkpointStorage = CheckpointStorage__factory.connect(
      deployedAddress,
      multiProvider.getSignerOrProvider(chain),
    );
  });

  describe('create', () => {
    it('deploys a new checkpoint storage contract', async () => {
      const deployedAddress = (checkpointModule as any).args.addresses
        .checkpointStorage;
      expect(deployedAddress).to.be.a('string');
      expect(deployedAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should write and fetch announcement correctly', async () => {
    // Use the signer's address as the validator address since it needs to match
    const validatorAddress = await signer.getAddress();
    const mockMailboxAddress = ethers.utils.hexlify(
      ethers.utils.randomBytes(32),
    );
    const mockAnnouncement = {
      value: {
        validator: validatorAddress,
        mailboxAddress: mockMailboxAddress,
        mailboxDomain: 1,
        storageLocation: 'test_location',
      },
      // Sign the announcement with the validator's key
      signature: await signer.signMessage(
        ethers.utils.arrayify(
          ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
              ['address', 'bytes32', 'uint32', 'string'],
              [validatorAddress, mockMailboxAddress, 1, 'test_location'],
            ),
          ),
        ),
      ),
    };

    // Write announcement
    await checkpointStorage.writeAnnouncement(
      mockAnnouncement.value,
      mockAnnouncement.signature,
    );

    // Fetch announcement
    const fetchedAnnouncement = await checkpointStorage.fetchAnnouncement(
      validatorAddress,
    );
    expect(fetchedAnnouncement.signature).to.equal(mockAnnouncement.signature);
    expect(fetchedAnnouncement.value.validator).to.equal(
      mockAnnouncement.value.validator,
    );
    expect(fetchedAnnouncement.value.mailboxAddress).to.equal(
      mockAnnouncement.value.mailboxAddress,
    );
    expect(fetchedAnnouncement.value.mailboxDomain).to.equal(
      mockAnnouncement.value.mailboxDomain,
    );
    expect(fetchedAnnouncement.value.storageLocation).to.equal(
      mockAnnouncement.value.storageLocation,
    );
  });
});
