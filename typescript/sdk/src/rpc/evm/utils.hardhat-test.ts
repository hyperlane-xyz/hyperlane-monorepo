import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../../test/testUtils.js';

import { getContractCreationBlockFromRpc, getLogsFromRpc } from './utils.js';

chai.use(chaiAsPromised);

describe('RPC Utils', () => {
  let contractOwner: SignerWithAddress;
  let tokenRecipient1: SignerWithAddress;
  let tokenRecipient2: SignerWithAddress;
  let providerChainTest1: JsonRpcProvider;
  let multiProvider: MultiProvider;
  let testContract: ERC20Test;
  let erc20Factory: ERC20Test__factory;
  let deploymentBlockNumber: number;

  const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');

  beforeEach(async () => {
    [contractOwner, tokenRecipient1, tokenRecipient2] =
      await hre.ethers.getSigners();

    assert(
      contractOwner.provider,
      'Expected provider to be defined on the signer',
    );

    // Initialize MultiProvider with test chain
    multiProvider = MultiProvider.createTestMultiProvider({
      signer: contractOwner,
      provider: contractOwner.provider,
    });
    providerChainTest1 = contractOwner.provider as JsonRpcProvider;

    // Get contract factory for ERC20Test
    erc20Factory = new ERC20Test__factory(contractOwner);
  });

  async function deployTestErc20() {
    testContract = await erc20Factory.deploy(
      'TestToken',
      'TST',
      ethers.utils.parseEther('1000000'),
      18,
    );

    await testContract.deployed();
    assert(
      testContract.deployTransaction.blockNumber,
      'Expected the Contract deployment block number to be defined',
    );
    deploymentBlockNumber = testContract.deployTransaction.blockNumber;
  }

  async function mineRandomNumberOfBlocks() {
    const blocksToMine = randomInt(69, 420);
    for (let blockNum = 0; blockNum < blocksToMine; blockNum++) {
      await providerChainTest1.send('evm_mine', []);
    }
  }

  describe(getContractCreationBlockFromRpc.name, () => {
    afterEach(() => sinon.restore());

    it('should find the correct deployment block for a deployed contract', async () => {
      await mineRandomNumberOfBlocks();

      await deployTestErc20();

      await mineRandomNumberOfBlocks();

      const foundBlock = await getContractCreationBlockFromRpc(
        TestChainName.test1,
        testContract.address,
        multiProvider,
      );

      expect(foundBlock).to.equal(deploymentBlockNumber);
      const contractCode = await providerChainTest1.getCode(
        testContract.address,
      );
      expect(contractCode).not.to.equal('0x');
    });

    // A pruned endpoint can still serve logs while lacking the historical state
    // the deployment search needs. That observable failure must stop the read;
    // scanning from genesis can take an infeasible number of requests.
    it('should fail when the endpoint cannot serve historical state', async () => {
      await mineRandomNumberOfBlocks();

      await deployTestErc20();

      await mineRandomNumberOfBlocks();

      const provider = multiProvider.getProvider(TestChainName.test1);
      const codeAtHead = provider.getCode.bind(provider);
      const historicalStateError = new Error(
        'missing trie node 8a1c7f (path ) state 0x8a1c7f is not available',
      );
      const getCode = sinon
        .stub(provider, 'getCode')
        .callsFake(async (address, blockTag) => {
          if (isNullish(blockTag)) {
            return codeAtHead(address);
          }
          // How a pruned geth reports state it no longer holds, and what 0g's
          // endpoints answer a historical eth_getCode with at any depth.
          throw historicalStateError;
        });

      await expect(
        getContractCreationBlockFromRpc(
          TestChainName.test1,
          testContract.address,
          multiProvider,
        ),
      ).to.be.rejectedWith(historicalStateError.message);

      // The first probe that cannot be answered ends the search.
      const historicalProbes = getCode
        .getCalls()
        .filter((call) => !isNullish(call.args[1]));
      expect(historicalProbes).to.have.length(1);
    });

    // A successful but false response cannot be distinguished locally from
    // genuine pre-deployment state. This records the data-source trust boundary.
    it('documents that silent pruning places the deployment too late', async () => {
      await mineRandomNumberOfBlocks();

      await deployTestErc20();

      await mineRandomNumberOfBlocks();
      await mineRandomNumberOfBlocks();

      const provider = multiProvider.getProvider(TestChainName.test1);
      const realGetCode = provider.getCode.bind(provider);

      // The contract exists from deploymentBlockNumber, but the endpoint only
      // holds state from a later block and answers below it as though it were
      // empty.
      const retentionFloor = deploymentBlockNumber + 5;
      expect(
        await realGetCode(testContract.address, deploymentBlockNumber),
      ).not.to.equal('0x');

      sinon.stub(provider, 'getCode').callsFake(async (address, blockTag) => {
        if (isNullish(blockTag) || Number(blockTag) >= retentionFloor) {
          return realGetCode(address, blockTag);
        }
        return '0x';
      });

      const foundBlock = await getContractCreationBlockFromRpc(
        TestChainName.test1,
        testContract.address,
        multiProvider,
      );

      // The search trusts the successful response and settles on the oldest
      // block the endpoint claims has code.
      expect(foundBlock).to.be.greaterThan(deploymentBlockNumber);
      expect(foundBlock).to.equal(retentionFloor);
    });

    it('should throw an error for non-existing contract address', async () => {
      const nonExistentAddress = randomAddress();

      await expect(
        getContractCreationBlockFromRpc(
          TestChainName.test1,
          nonExistentAddress,
          multiProvider,
        ),
      ).to.be.rejectedWith(
        `Address "${nonExistentAddress}" on chain "${TestChainName.test1}" is not a contract`,
      );
    });
  });

  describe(getLogsFromRpc.name, () => {
    beforeEach(async () => {
      await deployTestErc20();
    });

    it('should retrieve logs for Transfer events emitted by the contract', async () => {
      // Emit some Transfer events
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();

      const tx2 = await testContract.transfer(
        tokenRecipient2.address,
        ethers.utils.parseEther('200'),
      );
      await tx2.wait();

      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: transferTopic,
      });

      // Should have 3 transfer events: 1 from constructor mint + 2 from transfers
      expect(logs).to.have.length(3);
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work when fromBlock and toBlock are provided', async () => {
      await mineRandomNumberOfBlocks();
      const startBlock = await providerChainTest1.getBlockNumber();

      // Emit event in first block
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();
      const firstEventBlock = await providerChainTest1.getBlockNumber();

      await mineRandomNumberOfBlocks();

      // Emit event in later block
      const tx2 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('200'),
      );
      await tx2.wait();

      // Query only the first event's block range
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: startBlock,
        toBlock: firstEventBlock,
        topic: transferTopic,
      });

      expect(logs).to.have.length(1);
      expect(logs[0].blockNumber).to.equal(firstEventBlock);
    });

    it('should work when a custom range parameter is provided', async () => {
      const numberOfEventsToEmit = randomInt(1, 47);
      for (let i = 0; i < numberOfEventsToEmit; i++) {
        const tx = await testContract.mint(
          ethers.utils.parseEther(`${(i + 1) * 100}`),
        );
        await tx.wait();
      }

      // +1 because of the transfer event emitted on contract deployment
      const expectedNumberOfEvents = numberOfEventsToEmit + 1;
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: transferTopic,
        // Small range to test chunking
        range: 2,
      });

      expect(logs).to.have.length(expectedNumberOfEvents);
    });

    it('should return empty array when no logs match the criteria', async () => {
      // Emitting an event just to be sure that filtering works as expected
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();

      const nonExistentTopic = ethers.utils.id('NonExistentEvent(uint256)');
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: nonExistentTopic,
      });

      expect(logs).to.have.length(0);
    });

    describe('block range pagination', () => {
      let getLogsStub: sinon.SinonStub | undefined;

      afterEach(() => {
        getLogsStub?.restore();
        getLogsStub = undefined;
      });

      type ObservedChunk = { fromBlock: number; toBlock: number };

      const REJECTION_MESSAGE = 'query returned more than 10000 results';

      // A span rejection phrased in a way BLOCK_RANGE_ERROR_SIGNALS does not
      // cover, which the paginator must therefore treat as transient at first.
      const UNRECOGNISED_REJECTION_MESSAGE =
        'exceeds the maximum window for this endpoint';

      const TRANSIENT_MESSAGE = '429 Too Many Requests';

      function stubGetLogs(
        onChunk: (chunk: ObservedChunk) => void,
      ): ObservedChunk[] {
        const provider = multiProvider.getProvider(TestChainName.test1);
        const requested: ObservedChunk[] = [];

        getLogsStub = sinon
          .stub(provider, 'getLogs')
          .callsFake(async (filter) => {
            const resolved = await filter;
            assert(
              resolved &&
                'fromBlock' in resolved &&
                typeof resolved.fromBlock === 'number',
              'Expected getLogsFromRpc to request a numeric fromBlock',
            );
            assert(
              'toBlock' in resolved && typeof resolved.toBlock === 'number',
              'Expected getLogsFromRpc to request a numeric toBlock',
            );

            const chunk = {
              fromBlock: resolved.fromBlock,
              toBlock: resolved.toBlock,
            };
            requested.push(chunk);
            onChunk(chunk);

            return [];
          });

        return requested;
      }

      // Mimics the providers that cap how many blocks a single eth_getLogs
      // request may span. Returns every chunk the paginator requested; the
      // accepted ones are the entries whose span is at most `maxSpan`.
      function stubBlockSpanLimit(
        maxSpan: number,
        message = REJECTION_MESSAGE,
      ): ObservedChunk[] {
        return stubGetLogs((chunk) => {
          if (chunk.toBlock - chunk.fromBlock + 1 > maxSpan) {
            throw new Error(message);
          }
        });
      }

      // Mimics an endpoint that is temporarily unavailable: the failure says
      // nothing about the block range, so the range must not shrink.
      function stubTransientFailures(failureCount: number): ObservedChunk[] {
        let failuresLeft = failureCount;
        return stubGetLogs(() => {
          if (failuresLeft > 0) {
            failuresLeft--;
            throw new Error(TRANSIENT_MESSAGE);
          }
        });
      }

      function spanOf({ fromBlock, toBlock }: ObservedChunk): number {
        return toBlock - fromBlock + 1;
      }

      // Collapses the repeats a retried chunk leaves behind so the remaining
      // entries can be checked for gaps.
      function dedupeConsecutive(chunks: ObservedChunk[]): ObservedChunk[] {
        return chunks.filter(
          (chunk, index) =>
            index === 0 ||
            chunk.fromBlock !== chunks[index - 1].fromBlock ||
            chunk.toBlock !== chunks[index - 1].toBlock,
        );
      }

      // The accepted chunks must tile [fromBlock, toBlock] without gaps or
      // overlaps, otherwise the paginator silently skips or re-reads blocks.
      function expectContiguousCoverage(
        accepted: ObservedChunk[],
        fromBlock: number,
        toBlock: number,
      ): void {
        expect(accepted.length).to.be.greaterThan(0);
        expect(accepted[0].fromBlock).to.equal(fromBlock);
        expect(accepted[accepted.length - 1].toBlock).to.equal(toBlock);
        for (let i = 1; i < accepted.length; i++) {
          expect(accepted[i].fromBlock).to.equal(accepted[i - 1].toBlock + 1);
        }
      }

      async function mineBlocks(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
          await providerChainTest1.send('evm_mine', []);
        }
      }

      it('should never span more blocks than the configured range', async () => {
        const range = 8;
        const requested = stubBlockSpanLimit(range);

        await mineBlocks(100);
        const toBlock = await providerChainTest1.getBlockNumber();

        await getLogsFromRpc({
          chain: TestChainName.test1,
          contractAddress: testContract.address,
          multiProvider,
          fromBlock: deploymentBlockNumber,
          toBlock,
          topic: transferTopic,
          range,
        });

        // Every request was accepted, so a chunk never exceeded the range
        const totalBlocks = toBlock - deploymentBlockNumber + 1;
        expect(requested).to.have.length(Math.ceil(totalBlocks / range));
        expect(Math.max(...requested.map(spanOf))).to.equal(range);
        expectContiguousCoverage(requested, deploymentBlockNumber, toBlock);
      });

      it('should halve the block range on rejection and keep it reduced', async () => {
        const maxSpan = 4;
        const requested = stubBlockSpanLimit(maxSpan);

        await mineBlocks(100);
        const toBlock = await providerChainTest1.getBlockNumber();

        await getLogsFromRpc({
          chain: TestChainName.test1,
          contractAddress: testContract.address,
          multiProvider,
          fromBlock: deploymentBlockNumber,
          toBlock,
          topic: transferTopic,
          range: 16,
        });

        // 16 and 8 are rejected before 4 is accepted, and the reduced range is
        // reused for every following chunk instead of growing back
        expect(requested.slice(0, 2).map(spanOf)).to.deep.equal([16, 8]);
        expect(
          requested.filter((chunk) => spanOf(chunk) > maxSpan),
        ).to.have.length(2);
        expectContiguousCoverage(
          requested.filter((chunk) => spanOf(chunk) <= maxSpan),
          deploymentBlockNumber,
          toBlock,
        );
      });

      it('should rethrow the provider error once the range cannot be reduced further', async () => {
        const requested = stubBlockSpanLimit(0);

        await mineBlocks(10);
        const toBlock = await providerChainTest1.getBlockNumber();

        await expect(
          getLogsFromRpc({
            chain: TestChainName.test1,
            contractAddress: testContract.address,
            multiProvider,
            fromBlock: deploymentBlockNumber,
            toBlock,
            topic: transferTopic,
            range: 4,
          }),
        ).to.be.rejectedWith(REJECTION_MESSAGE);

        expect(requested.map(spanOf)).to.deep.equal([4, 2, 1]);
      });

      // Neither a retry nor a narrower range changes the answer to a rejection
      // of the caller, so walking one down the halving ladder only delays it by
      // four attempts and their backoffs at every range down to one block.
      it('should rethrow a rejected request without retrying or reducing the range', async () => {
        const requested = stubGetLogs(() => {
          throw Object.assign(new Error('bad response'), { status: 401 });
        });

        await mineBlocks(10);
        const toBlock = await providerChainTest1.getBlockNumber();

        await expect(
          getLogsFromRpc({
            chain: TestChainName.test1,
            contractAddress: testContract.address,
            multiProvider,
            fromBlock: deploymentBlockNumber,
            toBlock,
            topic: transferTopic,
            range: 4,
          }),
        ).to.be.rejectedWith('bad response');

        expect(requested.map(spanOf)).to.deep.equal([4]);
      });

      it('should rethrow a non recoverable error reported behind a wrapper', async () => {
        const requested = stubGetLogs(() => {
          throw new Error('All providers failed on chain test1', {
            cause: Object.assign(new Error('NETWORK_ERROR'), {
              isRecoverable: false,
            }),
          });
        });

        await mineBlocks(10);
        const toBlock = await providerChainTest1.getBlockNumber();

        await expect(
          getLogsFromRpc({
            chain: TestChainName.test1,
            contractAddress: testContract.address,
            multiProvider,
            fromBlock: deploymentBlockNumber,
            toBlock,
            topic: transferTopic,
            range: 4,
          }),
        ).to.be.rejectedWith('All providers failed on chain test1');

        expect(requested.map(spanOf)).to.deep.equal([4]);
      });

      // Shrinking the range is sticky for the rest of the scan, so a failure
      // that says nothing about the block range must cost a retry rather than
      // permanently degrading every remaining chunk.
      it('should retry a transient failure at the unchanged block range', async () => {
        const range = 16;
        const requested = stubTransientFailures(2);

        await mineBlocks(100);
        const toBlock = await providerChainTest1.getBlockNumber();

        await getLogsFromRpc({
          chain: TestChainName.test1,
          contractAddress: testContract.address,
          multiProvider,
          fromBlock: deploymentBlockNumber,
          toBlock,
          topic: transferTopic,
          range,
        });

        // The first chunk is requested three times unchanged before it succeeds
        expect(requested.slice(0, 3)).to.deep.equal([
          requested[0],
          requested[0],
          requested[0],
        ]);
        expect(Math.max(...requested.map(spanOf))).to.equal(range);
        expectContiguousCoverage(
          dedupeConsecutive(requested),
          deploymentBlockNumber,
          toBlock,
        );
      });

      // A spent retry budget is not proof that the failure is unrelated to the
      // block range, only that the signal list did not recognise it, so the
      // range is halved before the read is given up on.
      it('should halve the block range once the transient retry budget is spent', async () => {
        const requested = stubTransientFailures(Number.POSITIVE_INFINITY);

        await mineBlocks(450);
        const toBlock = await providerChainTest1.getBlockNumber();

        await expect(
          getLogsFromRpc({
            chain: TestChainName.test1,
            contractAddress: testContract.address,
            multiProvider,
            fromBlock: deploymentBlockNumber,
            toBlock,
            topic: transferTopic,
            range: 400,
          }),
        ).to.be.rejectedWith(TRANSIENT_MESSAGE);

        // One attempt plus three retries at each range down to a hundred
        // blocks, below which a failure naming no span is taken as an outage
        // rather than an unrecognised cap and the original provider error is
        // rethrown unchanged.
        expect(requested.map(spanOf)).to.deep.equal([
          400, 400, 400, 400, 200, 200, 200, 200, 100, 100, 100, 100,
        ]);
      });

      // The signal list is an optimisation, not a correctness dependency for
      // any cap above the hundred block floor: a provider phrasing it does not
      // cover costs retries, not the scan.
      it('should complete the scan when a span rejection is not recognised', async () => {
        const maxSpan = 150;
        const requested = stubBlockSpanLimit(
          maxSpan,
          UNRECOGNISED_REJECTION_MESSAGE,
        );

        await mineBlocks(450);
        const toBlock = await providerChainTest1.getBlockNumber();

        await getLogsFromRpc({
          chain: TestChainName.test1,
          contractAddress: testContract.address,
          multiProvider,
          fromBlock: deploymentBlockNumber,
          toBlock,
          topic: transferTopic,
          range: 400,
        });

        // 400 and 200 each exhaust the retry budget before 100 is accepted
        expect(requested.slice(0, 8).map(spanOf)).to.deep.equal([
          400, 400, 400, 400, 200, 200, 200, 200,
        ]);
        expectContiguousCoverage(
          requested.filter((chunk) => spanOf(chunk) <= maxSpan),
          deploymentBlockNumber,
          toBlock,
        );
      });

      it('should reject a range below the supported minimum', async () => {
        await expect(
          getLogsFromRpc({
            chain: TestChainName.test1,
            contractAddress: testContract.address,
            multiProvider,
            fromBlock: deploymentBlockNumber,
            topic: transferTopic,
            range: 0,
          }),
        ).to.be.rejectedWith(
          'Log pagination range must be an integer of at least 1, got 0',
        );
      });
    });
  });
});
