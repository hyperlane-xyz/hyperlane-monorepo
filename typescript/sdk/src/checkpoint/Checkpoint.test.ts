import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import {
  CheckpointStorage,
  CheckpointStorage__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

describe('CheckpointStorage', () => {
  let checkpointStorage: CheckpointStorage;
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;

  const generateRandomAddress = () => ethers.Wallet.createRandom().address;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should write and fetch checkpoint correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockIndex = 1;
    const mockSignedCheckpoint = {
      checkpoint: {
        index: mockIndex,
        root: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        mailbox: mockAddress,
        mailboxDomain: 1,
        origin: 1,
        merkleTree: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        messageId: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      },
      signature: ethers.utils.hexlify(ethers.utils.randomBytes(65)),
    };

    // Mock contract methods
    const mockContract = {
      writeCheckpoint: sandbox.stub().resolves(),
      fetchCheckpoint: sandbox.stub().resolves(mockSignedCheckpoint),
      latestIndex: sandbox.stub().resolves(mockIndex),
    };

    sandbox
      .stub(CheckpointStorage__factory, 'connect')
      .returns(mockContract as unknown as CheckpointStorage);

    checkpointStorage = CheckpointStorage__factory.connect(
      mockAddress,
      multiProvider.getProvider(TestChainName.test1),
    );

    // Write checkpoint
    await checkpointStorage.writeCheckpoint(mockSignedCheckpoint);
    expect(mockContract.writeCheckpoint.calledOnce).to.be.true;

    // Fetch checkpoint
    const fetchedCheckpoint = await checkpointStorage.fetchCheckpoint(
      mockAddress,
      mockIndex,
    );
    expect(fetchedCheckpoint).to.deep.equal(mockSignedCheckpoint);
  });

  it('should write and fetch metadata correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockGitSha = 'abc123';
    const mockMetadata = {
      gitSha: mockGitSha,
    };

    // Mock contract methods
    const mockContract = {
      writeMetadata: sandbox.stub().resolves(),
      fetchMetadata: sandbox.stub().resolves(mockMetadata),
    };

    sandbox
      .stub(CheckpointStorage__factory, 'connect')
      .returns(mockContract as unknown as CheckpointStorage);

    checkpointStorage = CheckpointStorage__factory.connect(
      mockAddress,
      multiProvider.getProvider(TestChainName.test1),
    );

    // Write metadata
    await checkpointStorage.writeMetadata(mockGitSha);
    expect(mockContract.writeMetadata.calledOnce).to.be.true;

    // Fetch metadata
    const fetchedMetadata = await checkpointStorage.fetchMetadata(mockAddress);
    expect(fetchedMetadata).to.deep.equal(mockMetadata);
  });

  it('should write and fetch announcement correctly', async () => {
    const mockAddress = generateRandomAddress();
    const mockMailboxAddress = ethers.utils.hexlify(
      ethers.utils.randomBytes(32),
    );
    const mockAnnouncement = {
      value: {
        validator: mockAddress,
        mailboxAddress: mockMailboxAddress,
        mailboxDomain: 1,
        storageLocation: 'ipfs://test',
      },
      signature: ethers.utils.hexlify(ethers.utils.randomBytes(72)),
    };

    // Mock contract methods
    const mockContract = {
      writeAnnouncement: sandbox.stub().resolves(),
      fetchAnnouncement: sandbox.stub().resolves(mockAnnouncement),
    };

    sandbox
      .stub(CheckpointStorage__factory, 'connect')
      .returns(mockContract as unknown as CheckpointStorage);

    checkpointStorage = CheckpointStorage__factory.connect(
      mockAddress,
      multiProvider.getProvider(TestChainName.test1),
    );

    // Write announcement
    await checkpointStorage.writeAnnouncement(
      mockAnnouncement.value,
      mockAnnouncement.signature,
    );
    expect(mockContract.writeAnnouncement.calledOnce).to.be.true;

    // Fetch announcement
    const fetchedAnnouncement = await checkpointStorage.fetchAnnouncement(
      mockAddress,
    );
    expect(fetchedAnnouncement).to.deep.equal(mockAnnouncement);
  });
});
