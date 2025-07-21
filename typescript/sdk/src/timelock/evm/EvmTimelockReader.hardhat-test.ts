import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { assert, deepCopy, normalizeAddressEvm } from '@hyperlane-xyz/utils';

import {
  KNOWN_BASE_TIMELOCK_CONTRACT,
  TestChainName,
  baseTestChain,
  test1,
} from '../../consts/testChains.js';
import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { ZBytes32String } from '../../metadata/customZodTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { TimelockConfig, TimelockTx } from '../types.js';

import { EvmTimelockDeployer } from './EvmTimelockDeployer.js';
import { EvmTimelockReader } from './EvmTimelockReader.js';
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

    describe(`${EvmTimelockReader.prototype.getScheduledOperations.name}`, () => {
      it('should return empty object when no transactions are scheduled', async () => {
        const scheduledTxs = await timelockReader.getScheduledOperations();

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

          const scheduledTxs = await timelockReader.getScheduledOperations();
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

    describe(`${EvmTimelockReader.prototype.getExecutedOperationIds.name}`, () => {
      it('should return empty set when no transactions are executed', async () => {
        const executedIds = await timelockReader.getExecutedOperationIds();

        expect(executedIds.size).to.equal(0);
      });

      type ExecuteTestCase = {
        title: string;
        timelockTxs: Array<Omit<TimelockTx, 'id'>>;
      };

      const executeTestCases: ExecuteTestCase[] = [
        {
          title: 'should retrieve single executed operation ID correctly',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('execute-test'),
            },
          ],
        },
        {
          title: 'should handle multiple executed operations',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('execute-1'),
            },
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('execute-2'),
            },
          ],
        },
      ];

      for (const { title, timelockTxs } of executeTestCases) {
        it(title, async () => {
          const proposerTimelock = TimelockController__factory.connect(
            timelockAddress,
            proposer,
          );
          const executorTimelock = TimelockController__factory.connect(
            timelockAddress,
            executor,
          );

          const operationIds: string[] = [];

          // Schedule and execute operations
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

            // Execute
            const executeTx = await executorTimelock.executeBatch(
              targets,
              values,
              dataArray,
              timelockTx.predecessor,
              timelockTx.salt,
            );
            await executeTx.wait();
          }

          const executedIds = await timelockReader.getExecutedOperationIds();
          expect(executedIds.size).to.equal(timelockTxs.length);

          for (const operationId of operationIds) {
            expect(executedIds.has(operationId)).to.be.true;
          }
        });
      }
    });

    describe(`${EvmTimelockReader.prototype.getReadyOperationIds.name}`, () => {
      it('should return empty set for empty input', async () => {
        const readyIds = await timelockReader.getReadyOperationIds([]);

        expect(readyIds.size).to.equal(0);
      });

      type ReadyTestCase = {
        title: string;
        timelockTxs: Array<Omit<TimelockTx, 'id'>>;
        expectedReadyCount: number;
      };

      const readyTestCases: ReadyTestCase[] = [
        {
          title: 'should return ready operations correctly (no delay)',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('ready-test'),
            },
          ],
          expectedReadyCount: 1,
        },
        {
          title: 'should filter out non-ready operations (with delay)',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 3600,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('not-ready'),
            },
          ],
          expectedReadyCount: 0,
        },
        {
          title: 'should handle mixed ready and non-ready operations',
          timelockTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('ready-1'),
            },
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 3600,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('not-ready-1'),
            },
          ],
          expectedReadyCount: 1,
        },
      ];

      for (const { title, timelockTxs, expectedReadyCount } of readyTestCases) {
        it(title, async () => {
          const proposerTimelock = TimelockController__factory.connect(
            timelockAddress,
            proposer,
          );

          const operationIds: string[] = [];

          // Schedule operations
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
          }

          const readyIds =
            await timelockReader.getReadyOperationIds(operationIds);
          expect(readyIds.size).to.equal(expectedReadyCount);
        });
      }
    });

    describe(`${EvmTimelockReader.prototype.getScheduledExecutableTransactions.name}`, () => {
      it('should return empty object when no executable transactions exist', async () => {
        const executableTxs =
          await timelockReader.getScheduledExecutableTransactions();

        expect(executableTxs).to.deep.equal({});
      });

      type ExecutableTestCase = {
        title: string;
        scheduledTxs: Array<Omit<TimelockTx, 'id'>>;
        cancelledTxIndexes?: number[];
        executedTxIndexes?: number[];
        expectedExecutableCount: number;
      };

      const executableTestCases: ExecutableTestCase[] = [
        {
          title: 'should return scheduled executable transactions',
          scheduledTxs: [
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
              salt: ethers.utils.formatBytes32String('executable'),
            },
          ],
          expectedExecutableCount: 1,
        },
        {
          title: 'should exclude cancelled transactions from executable list',
          scheduledTxs: [
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
              salt: ethers.utils.formatBytes32String('cancelled'),
            },
          ],
          cancelledTxIndexes: [0],
          expectedExecutableCount: 0,
        },
        {
          title: 'should exclude executed transactions from executable list',
          scheduledTxs: [
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('executed'),
            },
          ],
          executedTxIndexes: [0],
          expectedExecutableCount: 0,
        },
        {
          title:
            'should handle mixed scheduled, cancelled, and executed transactions',
          scheduledTxs: [
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
              salt: ethers.utils.formatBytes32String('executable-1'),
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
              salt: ethers.utils.formatBytes32String('cancelled-1'),
            },
            {
              data: [
                {
                  to: randomAddress(),
                  value: ethers.BigNumber.from(0),
                  data: '0x',
                },
              ],
              delay: 0,
              predecessor: EMPTY_BYTES_32,
              salt: ethers.utils.formatBytes32String('executed-1'),
            },
          ],
          cancelledTxIndexes: [1],
          executedTxIndexes: [2],
          expectedExecutableCount: 1,
        },
      ];

      for (const {
        title,
        scheduledTxs,
        cancelledTxIndexes,
        executedTxIndexes,
        expectedExecutableCount,
      } of executableTestCases) {
        it(title, async () => {
          const proposerTimelock = TimelockController__factory.connect(
            timelockAddress,
            proposer,
          );
          const executorTimelock = TimelockController__factory.connect(
            timelockAddress,
            executor,
          );

          const operationIds: string[] = [];

          // Schedule all transactions
          for (const timelockTx of scheduledTxs) {
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
          }

          // Cancel specific transactions
          if (cancelledTxIndexes) {
            for (const index of cancelledTxIndexes) {
              const cancelTx = await proposerTimelock.cancel(
                operationIds[index],
              );
              await cancelTx.wait();
            }
          }

          // Execute specific transactions
          if (executedTxIndexes) {
            for (const index of executedTxIndexes) {
              const timelockTx = scheduledTxs[index];
              const targets = timelockTx.data.map((tx) => tx.to);
              const values = timelockTx.data.map((tx) => tx.value ?? '0');
              const dataArray = timelockTx.data.map((tx) => tx.data);

              const executeTx = await executorTimelock.executeBatch(
                targets,
                values,
                dataArray,
                timelockTx.predecessor,
                timelockTx.salt,
              );
              await executeTx.wait();
            }
          }

          const executableTxs =
            await timelockReader.getScheduledExecutableTransactions();
          const txIds = Object.keys(executableTxs);

          expect(txIds).to.have.length(expectedExecutableCount);

          // Verify structure of executable transactions
          for (const [txId, executableTx] of Object.entries(executableTxs)) {
            expect(executableTx.id).to.equal(txId);
            expect(executableTx.data).to.be.an('array');
            expect(executableTx.data.length).to.be.greaterThan(0);
            expect(executableTx.encodedExecuteTransaction).to.be.a('string');
            expect(
              executableTx.encodedExecuteTransaction.length,
            ).to.be.greaterThan(0);
            expect(executableTx.delay).to.be.a('number');
            expect(executableTx.predecessor).to.be.a('string');
            expect(executableTx.salt).to.be.a('string');
          }
        });
      }
    });
  });

  describe(`${EvmTimelockReader.name} (Block Explorer)`, () => {
    let reader: EvmTimelockReader;
    let multiProvider: MultiProvider;

    beforeEach(async () => {
      multiProvider = new MultiProvider({
        base: baseTestChain,
      });
      reader = EvmTimelockReader.fromConfig({
        chain: baseTestChain.name,
        timelockAddress: KNOWN_BASE_TIMELOCK_CONTRACT,
        multiProvider,
      });
    });

    describe(`${EvmTimelockReader.prototype.getScheduledOperations.name}`, () => {
      it('should retrieve scheduled transactions from block explorer API', async () => {
        const scheduledTxs: Record<string, TimelockTx> =
          await reader.getScheduledOperations();

        // Should find some scheduled transactions on this timelock
        expect(Object.keys(scheduledTxs).length).to.be.greaterThan(0);

        // Validate structure of returned transactions
        for (const [txId, tx] of Object.entries(scheduledTxs)) {
          expect(ZBytes32String.safeParse(txId).success).to.be.true;

          expect(tx.id).to.equal(txId);
          expect(tx.data.length).to.be.greaterThan(0);
          expect(tx.delay).not.to.be.undefined;
          expect(ZBytes32String.safeParse(tx.predecessor).success).to.be.true;
          expect(ZBytes32String.safeParse(tx.salt).success).to.be.true;
        }
      });
    });

    describe(`${EvmTimelockReader.prototype.getCancelledOperationIds.name}`, () => {
      it('should retrieve cancelled operation IDs from block explorer API', async () => {
        const cancelledIds = await reader.getCancelledOperationIds();

        expect(cancelledIds).to.be.instanceOf(Set);
        for (const id of cancelledIds) {
          expect(ZBytes32String.safeParse(id).success).to.be.true;
        }
      });
    });

    describe(`${EvmTimelockReader.prototype.getExecutedOperationIds.name}`, () => {
      it('should retrieve executed operation IDs from block explorer API', async () => {
        const executedIds = await reader.getExecutedOperationIds();

        // Should find some executed transactions on this timelock
        expect(executedIds.size).to.be.greaterThan(0);
        for (const id of executedIds) {
          expect(ZBytes32String.safeParse(id).success).to.be.true;
        }
      });
    });

    describe(`${EvmTimelockReader.prototype.getScheduledExecutableTransactions.name}`, () => {
      it('should retrieve scheduled executable transactions from block explorer API', async () => {
        const executableTxs = await reader.getScheduledExecutableTransactions();

        for (const [txId, executableTx] of Object.entries(executableTxs)) {
          expect(executableTx.id).to.equal(txId);
          expect(ZBytes32String.safeParse(txId).success).to.be.true;
          expect(executableTx.data.length).to.be.greaterThan(0);
          expect(executableTx.encodedExecuteTransaction).to.be.a('string');
          expect(
            executableTx.encodedExecuteTransaction.length,
          ).to.be.greaterThan(0);
          expect(executableTx.delay).not.to.be.undefined;
          expect(ZBytes32String.safeParse(executableTx.predecessor).success).to
            .be.true;
          expect(ZBytes32String.safeParse(executableTx.salt).success).to.be
            .true;
        }
      });
    });
  });
});
