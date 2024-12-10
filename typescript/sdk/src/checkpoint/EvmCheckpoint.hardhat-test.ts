import { expect } from 'chai';
import { Signer } from 'ethers';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  CheckpointStorage,
  CheckpointStorage__factory,
  ValidatorAnnounce,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmCheckpointModule } from './EvmCheckpointModule.js';

describe('CheckpointModule', async () => {
  const chain = TestChainName.test1;

  let multiProvider: MultiProvider;
  let coreAddresses: CoreAddresses;
  let signer: Signer;
  let checkpointModule: EvmCheckpointModule;
  let checkpointStorage: CheckpointStorage;
  let validatorAnnounce: ValidatorAnnounce;

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

    const testCoreDeployer = new TestCoreDeployer(
      multiProvider,
      legacyIsmFactory,
    );

    // mailbox and proxy admin for the core deploy
    const {
      mailbox,
      proxyAdmin,
      validatorAnnounce: validatorAnnounceContract,
    } = (await testCoreDeployer.deployApp()).getContracts(chain);

    coreAddresses = {
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounceContract.address,
    };

    validatorAnnounce = ValidatorAnnounce__factory.connect(
      validatorAnnounceContract.address,
      multiProvider.getSignerOrProvider(chain),
    );
  });

  beforeEach(async () => {
    checkpointModule = await EvmCheckpointModule.create({
      chain,
      config: { chain },
      coreAddresses: {
        mailbox: coreAddresses.mailbox,
        validatorAnnounce: coreAddresses.validatorAnnounce,
      },
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

  it('should write and fetch checkpoint correctly', async () => {
    const validatorAddress = await signer.getAddress();
    const storageLocation = 's3://test-bucket/us-east-1';

    // Calculate message hash (same as inside getAnnouncementDigest but without toEthSignedMessageHash)
    const localDomain = await validatorAnnounce.localDomain();
    const mailboxAddress = await validatorAnnounce.mailbox();
    const domainHash2 = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['uint32', 'bytes32', 'string'],
        [
          localDomain,
          ethers.utils.hexZeroPad(mailboxAddress, 32),
          'HYPERLANE_ANNOUNCEMENT',
        ],
      ),
    );
    const messageHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'string'],
        [domainHash2, storageLocation],
      ),
    );

    const signatureObj = await signer.signMessage(
      ethers.utils.arrayify(messageHash),
    );
    const signature = ethers.utils.joinSignature(signatureObj);

    const tx = await validatorAnnounce.announce(
      validatorAddress,
      storageLocation,
      signature,
      multiProvider.getTransactionOverrides(chain),
    );
    await tx.wait();

    // Create a mock checkpoint
    const checkpoint = {
      origin: await multiProvider.getDomainId(chain),
      merkleTree: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      root: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      index: 1,
      messageId: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    };

    // Sign the checkpoint
    const domainHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['uint32', 'bytes32'],
        [checkpoint.origin, checkpoint.merkleTree],
      ),
    );
    const checkpointDigest = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'bytes32', 'uint32', 'bytes32'],
        [domainHash, checkpoint.root, checkpoint.index, checkpoint.messageId],
      ),
    );
    const checkpointSignature = await signer.signMessage(
      ethers.utils.arrayify(checkpointDigest),
    );

    await checkpointStorage.writeCheckpoint({
      checkpoint,
      signature: checkpointSignature,
    });

    const fetchedCheckpoint = await checkpointStorage.fetchCheckpoint(
      validatorAddress,
      checkpoint.index,
    );

    expect(fetchedCheckpoint.checkpoint.origin).to.equal(checkpoint.origin);
    expect(fetchedCheckpoint.checkpoint.merkleTree).to.equal(
      checkpoint.merkleTree,
    );
    expect(fetchedCheckpoint.checkpoint.root).to.equal(checkpoint.root);
    expect(fetchedCheckpoint.checkpoint.index).to.equal(checkpoint.index);
    expect(fetchedCheckpoint.checkpoint.messageId).to.equal(
      checkpoint.messageId,
    );
    expect(fetchedCheckpoint.signature).to.equal(checkpointSignature);
  });
});
