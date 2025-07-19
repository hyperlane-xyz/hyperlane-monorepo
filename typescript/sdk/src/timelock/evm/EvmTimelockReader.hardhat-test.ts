import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { assert, deepCopy, normalizeAddressEvm } from '@hyperlane-xyz/utils';

import { TestChainName, test1 } from '../../consts/testChains.js';
import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { TimelockConfig } from '../types.js';

import { EvmTimelockDeployer } from './EvmTimelockDeployer.js';
import { EvmTimelockReader, TimelockTx } from './EvmTimelockReader.js';
import { EMPTY_BYTES_32 } from './constants.js';

chai.use(chaiAsPromised);

describe(EvmTimelockReader.name, () => {
  let contractOwner: SignerWithAddress;
  let proposer: SignerWithAddress;
  let executor: SignerWithAddress;
  let providerChainTest1: JsonRpcProvider;
  let multiProvider: MultiProvider;
  let timelockDeployer: EvmTimelockDeployer;
  let timelockReader: EvmTimelockReader;
  let timelockAddress: string;
  let deploymentBlockNumber: number;

  beforeEach(async () => {
    [contractOwner, proposer, executor] = await hre.ethers.getSigners();

    assert(contractOwner.provider, 'Provider should be available');
    providerChainTest1 = contractOwner.provider as JsonRpcProvider;

    // Initialize MultiProvider with test chain
    const testChain1Clone: ChainMetadata = deepCopy(test1);
    testChain1Clone.blockExplorers = [];

    multiProvider = new MultiProvider({
      [TestChainName.test1]: testChain1Clone,
    });
    multiProvider.setProvider(TestChainName.test1, providerChainTest1);
    multiProvider.setSharedSigner(contractOwner);

    // Deploy timelock contract
    timelockDeployer = new EvmTimelockDeployer(multiProvider);
  });

  async function deployTestTimelock() {
    const config: TimelockConfig = {
      minimumDelay: 0,
      proposers: [proposer.address],
      executors: [executor.address],
      admin: contractOwner.address,
    };

    const { TimelockController } = await timelockDeployer.deployContracts(
      TestChainName.test1,
      config,
    );

    timelockAddress = TimelockController.address;

    assert(
      TimelockController.deployTransaction.blockNumber,
      'Expected the Timelock deployment block number to be defined',
    );
    deploymentBlockNumber = TimelockController.deployTransaction.blockNumber;

    return TimelockController;
  }

  describe(EvmTimelockReader.fromConfig.name, () => {
    beforeEach(async () => {
      await deployTestTimelock();
    });

    it('should initialize EvmTimelockReader using fromConfig', async () => {
      const reader = EvmTimelockReader.fromConfig({
        chain: TestChainName.test1,
        timelockAddress,
        multiProvider,
      });

      expect(reader).to.be.instanceOf(EvmTimelockReader);
      expect(reader['timelockInstance'].address).to.equal(timelockAddress);
      expect(reader['chain']).to.equal(TestChainName.test1);
    });

    it('should create reader with valid timelock address', async () => {
      expect(() => {
        EvmTimelockReader.fromConfig({
          chain: TestChainName.test1,
          timelockAddress,
          multiProvider,
        });
      }).to.not.throw();
    });
  });

  describe(`${EvmTimelockReader.name} (RPC)`, () => {
    beforeEach(async () => {
      await deployTestTimelock();

      timelockReader = EvmTimelockReader.fromConfig({
        chain: TestChainName.test1,
        timelockAddress,
        multiProvider,
      });
    });

    describe(`${EvmTimelockReader.prototype.getScheduledTransactions.name}`, () => {
      it('should return empty object when no transactions are scheduled', async () => {
        const scheduledTxs = await timelockReader.getScheduledTransactions();

        expect(scheduledTxs).to.deep.equal({});
      });

      type ScheduleTestCase = {
        title: string;
        timelockTx: Omit<TimelockTx, 'id'>;
      };

      const scheduleTestCases: ScheduleTestCase[] = [
        {
          title: 'should retrieve single scheduled transaction correctly',
          timelockTx: {
            data: [
              {
                to: randomAddress(),
                value: ethers.utils.parseEther('1'),
                data: '0x1234',
              },
            ],
            delay: 0,
            predecessor: EMPTY_BYTES_32,
            salt: ethers.utils.formatBytes32String('test-salt'),
          },
        },
        {
          title: 'should handle multiple scheduled transactions in a batch',
          timelockTx: {
            data: [
              {
                to: randomAddress(),
                value: ethers.utils.parseEther('1'),
                data: '0x1234',
              },
              {
                to: randomAddress(),
                value: ethers.utils.parseEther('2'),
                data: '0x5678',
              },
            ],
            delay: 0,
            predecessor: EMPTY_BYTES_32,
            salt: ethers.utils.formatBytes32String('batch-salt'),
          },
        },
        {
          title:
            'should handle transactions with no salt (using EMPTY_BYTES_32)',
          timelockTx: {
            data: [
              {
                to: randomAddress(),
                value: ethers.BigNumber.from(0),
                data: '0x',
              },
            ],
            delay: 0,
            predecessor: EMPTY_BYTES_32,
            salt: EMPTY_BYTES_32,
          },
        },
      ];

      for (const { title, timelockTx } of scheduleTestCases) {
        it(title, async () => {
          const proposerTimelock = TimelockController__factory.connect(
            timelockAddress,
            proposer,
          );

          const targets = timelockTx.data.map((tx) => tx.to);
          const values = timelockTx.data.map((tx) => tx.value ?? '0');
          const dataArray = timelockTx.data.map((tx) => tx.data);

          const scheduleTx = await proposerTimelock.scheduleBatch(
            targets,
            values,
            dataArray,
            timelockTx.predecessor,
            timelockTx.salt,
            timelockTx.delay,
          );
          await scheduleTx.wait();

          const scheduledTxs = await timelockReader.getScheduledTransactions();
          const txIds = Object.keys(scheduledTxs);

          expect(txIds).to.have.length(1);

          const scheduledTx: TimelockTx = scheduledTxs[txIds[0]];
          expect(scheduledTx.data).to.have.length(timelockTx.data.length);

          for (let i = 0; i < timelockTx.data.length; i++) {
            expect(normalizeAddressEvm(scheduledTx.data[i].to)).to.equal(
              normalizeAddressEvm(timelockTx.data[i].to),
            );
            assert(
              scheduledTx.data[i].value,
              'Expected value to be defined when reading from Timelock',
            );
            expect(scheduledTx.data[i].value?.toString()).to.equal(
              timelockTx.data[i].value?.toString() ?? '0',
            );
            expect(scheduledTx.data[i].data).to.equal(timelockTx.data[i].data);
          }

          expect(scheduledTx.delay).to.equal(timelockTx.delay);
          expect(scheduledTx.predecessor).to.equal(timelockTx.predecessor);
          expect(scheduledTx.salt).to.equal(timelockTx.salt);
          expect(scheduledTx.id).to.equal(txIds[0]);
        });
      }
    });

    describe(`${EvmTimelockReader.prototype.getCancelledOperationIds.name}`, () => {
      it('should return empty set when no transactions are cancelled', async () => {
        const cancelledIds = await timelockReader.getCancelledOperationIds();
        expect(cancelledIds.size).to.equal(0);
      });

      type CancelTestCase = {
        title: string;
        timelockTxs: Array<Omit<TimelockTx, 'id'>>;
      };

      const cancelTestCases: CancelTestCase[] = [
        {
          title: 'should retrieve single cancelled operation ID correctly',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x1234',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('cancel-test'),
            },
          ],
        },
        {
          title: 'should handle multiple cancelled operations',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x1234',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('cancel-1'),
            },
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x5678',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('cancel-2'),
            },
          ],
        },
      ];

      for (const { title, timelockTxs } of cancelTestCases) {
        it(title, async () => {
          const proposerTimelock = TimelockController__factory.connect(
            timelockAddress,
            proposer,
          );

          const operationIds: string[] = [];

          // Schedule and cancel operations
          for (const timelockTx of timelockTxs) {
            const targets = timelockTx.data.map((tx) => tx.to);
            const values = timelockTx.data.map((tx) => tx.value ?? '0');
            const dataArray = timelockTx.data.map((tx) => tx.data);

            // Schedule
            const scheduleTx = await proposerTimelock.scheduleBatch(
              targets,
              values,
              dataArray,
              timelockTx.predecessor,
              timelockTx.salt,
              timelockTx.delay,
            );
            await scheduleTx.wait();

            // Get operation ID
            const operationId = await proposerTimelock.hashOperationBatch(
              targets,
              values,
              dataArray,
              timelockTx.predecessor,
              timelockTx.salt,
            );
            operationIds.push(operationId);

            // Cancel
            const cancelTx = await proposerTimelock.cancel(operationId);
            await cancelTx.wait();
          }

          const cancelledIds = await timelockReader.getCancelledOperationIds();
          expect(cancelledIds.size).to.equal(timelockTxs.length);

          for (const operationId of operationIds) {
            expect(cancelledIds.has(operationId)).to.be.true;
          }
        });
      }
    });
  });

  describe(`${EvmTimelockReader.name} (Block Explorer)`, () => {});
});
