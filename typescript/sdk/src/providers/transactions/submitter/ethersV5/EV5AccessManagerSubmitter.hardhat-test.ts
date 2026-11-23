import { TransactionReceipt } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, providers } from 'ethers';
import hre from 'hardhat';

import {
  IAccessManager,
  IAccessManager__factory,
  TestRecipient,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
  deepCopy,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { TestChainName, test1 } from '../../../../consts/testChains.js';
import { ChainMetadata } from '../../../../metadata/chainMetadataTypes.js';
import { deployTestAccessManager } from '../../../../test/accessManager.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { getSubmitter } from '../submitterBuilderGetter.js';

import { EvmAccessManagerSubmitterProps } from './types.js';

chai.use(chaiAsPromised);

const CHAIN = TestChainName.test1;
// Differs from the hardhat EVM chain id so the chainId handling is exercised
const DOMAIN_ID = 9913371;
const IMMEDIATE_ROLE = 1;
const DELAYED_ROLE = 2;
const UNGRANTED_ROLE = 3;
const EXECUTION_DELAY = 3600;
const VALUE = BigNumber.from(1000);

type EvmReceipt = TransactionReceipt;

class CapturingSubmitter implements TxSubmitterInterface<ProtocolType.Ethereum> {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;
  public readonly submitted: AnnotatedEV5Transaction[] = [];
  public submitCalls = 0;

  async submit(...txs: AnnotatedEV5Transaction[]): Promise<EvmReceipt[]> {
    this.submitCalls += 1;
    this.submitted.push(...txs);
    return [];
  }
}

function isDeferredTx(value: unknown): value is AnnotatedEV5Transaction {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('transactionHash' in value) &&
    'data' in value &&
    typeof value.data === 'string'
  );
}

function isReceipt(value: unknown): value is EvmReceipt {
  return (
    typeof value === 'object' && value !== null && 'transactionHash' in value
  );
}

function splitOutput(output: void | EvmReceipt | EvmReceipt[]): {
  receipts: EvmReceipt[];
  deferred: AnnotatedEV5Transaction[];
} {
  assert(Array.isArray(output), 'Expected the submitter output to be an array');
  return {
    receipts: output.filter(isReceipt),
    deferred: output.filter(isDeferredTx),
  };
}

function toTxRequest(
  tx: AnnotatedEV5Transaction,
): providers.TransactionRequest {
  return {
    to: tx.to,
    from: tx.from,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
  };
}

describe(TxSubmitterType.ACCESS_MANAGER, () => {
  const accessManagerInterface = IAccessManager__factory.createInterface();

  let admin: SignerWithAddress;
  let provider: providers.JsonRpcProvider;
  let multiProvider: MultiProvider;
  let evmChainId: number;
  let accessManager: IAccessManager;
  // handle -> IMMEDIATE_ROLE, setInterchainSecurityModule -> UNGRANTED_ROLE
  let immediateRecipient: TestRecipient;
  // handle, fooBar -> DELAYED_ROLE
  let delayedRecipient: TestRecipient;

  function handleTx(
    recipient: TestRecipient,
    body: string,
    chainId: number = evmChainId,
  ): AnnotatedEV5Transaction {
    return {
      to: recipient.address,
      data: recipient.interface.encodeFunctionData('handle', [
        DOMAIN_ID,
        addressToBytes32(admin.address),
        body,
      ]),
      value: VALUE,
      chainId,
    };
  }

  function fooBarTx(
    recipient: TestRecipient,
    message: string,
  ): AnnotatedEV5Transaction {
    return {
      to: recipient.address,
      data: recipient.interface.encodeFunctionData('fooBar', [1, message]),
      chainId: evmChainId,
    };
  }

  function buildConfig(caller?: Address): EvmAccessManagerSubmitterProps {
    return {
      type: TxSubmitterType.ACCESS_MANAGER,
      chain: CHAIN,
      accessManagerAddress: accessManager.address,
      caller,
      proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: CHAIN },
    };
  }

  function getJsonRpcAccessManagerSubmitter(caller?: Address) {
    return getSubmitter<ProtocolType.Ethereum>(
      multiProvider,
      buildConfig(caller),
      {},
    );
  }

  function getCapturingAccessManagerSubmitter(
    proposer: CapturingSubmitter,
    caller?: Address,
  ) {
    return getSubmitter<ProtocolType.Ethereum>(
      multiProvider,
      buildConfig(caller),
      {},
      {
        [ProtocolType.Ethereum]: { [TxSubmitterType.JSON_RPC]: () => proposer },
      },
    );
  }

  function decode(tx: { data?: string }) {
    assert(tx.data, 'Expected tx data');
    return accessManagerInterface.parseTransaction({ data: tx.data });
  }

  function customErrorSelector(name: string): string {
    return accessManagerInterface.getSighash(
      accessManagerInterface.getError(name),
    );
  }

  async function increaseTime(seconds: number) {
    await provider.send('evm_increaseTime', [seconds]);
    await provider.send('evm_mine', []);
  }

  beforeEach(async () => {
    [admin] = await hre.ethers.getSigners();
    assert(admin.provider, 'Provider should be available');
    provider = hre.ethers.provider;
    ({ chainId: evmChainId } = await provider.getNetwork());
    expect(evmChainId).to.not.equal(DOMAIN_ID);

    const chainMetadata: ChainMetadata = deepCopy(test1);
    chainMetadata.blockExplorers = [];
    chainMetadata.chainId = evmChainId;
    chainMetadata.domainId = DOMAIN_ID;
    multiProvider = new MultiProvider({ [CHAIN]: chainMetadata });
    multiProvider.setProvider(CHAIN, provider);
    multiProvider.setSharedSigner(admin);

    accessManager = await deployTestAccessManager(admin, admin.address);
    const recipientFactory = new TestRecipient__factory(admin);
    immediateRecipient = await recipientFactory.deploy();
    delayedRecipient = await recipientFactory.deploy();
    for (const recipient of [immediateRecipient, delayedRecipient]) {
      await (await recipient.transferOwnership(accessManager.address)).wait();
    }

    const handleSelector = immediateRecipient.interface.getSighash('handle');
    const setIsmSelector = immediateRecipient.interface.getSighash(
      'setInterchainSecurityModule',
    );
    const fooBarSelector = delayedRecipient.interface.getSighash('fooBar');
    await (
      await accessManager.setTargetFunctionRole(
        immediateRecipient.address,
        [handleSelector],
        IMMEDIATE_ROLE,
      )
    ).wait();
    await (
      await accessManager.setTargetFunctionRole(
        immediateRecipient.address,
        [setIsmSelector],
        UNGRANTED_ROLE,
      )
    ).wait();
    await (
      await accessManager.setTargetFunctionRole(
        delayedRecipient.address,
        [handleSelector, fooBarSelector],
        DELAYED_ROLE,
      )
    ).wait();
    await (
      await accessManager.grantRole(IMMEDIATE_ROLE, admin.address, 0)
    ).wait();
    await (
      await accessManager.grantRole(
        DELAYED_ROLE,
        admin.address,
        EXECUTION_DELAY,
      )
    ).wait();
  });

  describe('with caller', () => {
    it('should execute immediately permitted calls right away, forwarding the value', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter(admin.address);
      const tx = handleTx(immediateRecipient, '0x01');

      const { receipts, deferred } = splitOutput(await submitter.submit(tx));

      expect(receipts).to.have.lengthOf(1);
      expect(deferred).to.have.lengthOf(0);
      expect(await immediateRecipient.lastData()).to.equal('0x01');
      expect((await provider.getBalance(immediateRecipient.address)).eq(VALUE))
        .to.be.true;
    });

    it('should schedule delayed calls and return an execute tx that succeeds only after the delay', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter(admin.address);
      const tx = handleTx(delayedRecipient, '0x02');

      const { receipts, deferred } = splitOutput(await submitter.submit(tx));

      expect(receipts).to.have.lengthOf(1);
      const [scheduleReceipt] = receipts;
      const scheduleTx = await provider.getTransaction(
        scheduleReceipt.transactionHash,
      );
      expect(eqAddress(scheduleTx.to ?? '', accessManager.address)).to.be.true;
      expect(scheduleTx.value.isZero()).to.be.true;
      const decodedSchedule = decode(scheduleTx);
      expect(decodedSchedule.name).to.equal('schedule');
      expect(eqAddress(decodedSchedule.args[0], delayedRecipient.address)).to.be
        .true;
      expect(decodedSchedule.args[1]).to.equal(tx.data);
      expect(decodedSchedule.args[2]).to.equal(0);

      expect(deferred).to.have.lengthOf(1);
      const [executeTx] = deferred;
      expect(eqAddress(executeTx.to ?? '', accessManager.address)).to.be.true;
      expect(executeTx.chainId).to.equal(evmChainId);
      expect(eqAddress(executeTx.from ?? '', admin.address)).to.be.true;
      expect(BigNumber.from(executeTx.value).eq(VALUE)).to.be.true;
      const decodedExecute = decode(executeTx);
      expect(decodedExecute.name).to.equal('execute');
      expect(eqAddress(decodedExecute.args[0], delayedRecipient.address)).to.be
        .true;
      expect(decodedExecute.args[1]).to.equal(tx.data);

      await expect(
        admin.sendTransaction(toTxRequest(executeTx)),
      ).to.be.rejectedWith(customErrorSelector('AccessManagerNotReady'));
      expect(await delayedRecipient.lastData()).to.equal('0x');

      await increaseTime(EXECUTION_DELAY);
      await (await admin.sendTransaction(toTxRequest(executeTx))).wait();

      expect(await delayedRecipient.lastData()).to.equal('0x02');
      expect((await provider.getBalance(delayedRecipient.address)).eq(VALUE)).to
        .be.true;
    });

    it('should throw with the function role info when the caller is not permitted', async () => {
      const proposer = new CapturingSubmitter();
      const submitter = await getCapturingAccessManagerSubmitter(
        proposer,
        admin.address,
      );
      const tx: AnnotatedEV5Transaction = {
        to: immediateRecipient.address,
        data: immediateRecipient.interface.encodeFunctionData(
          'setInterchainSecurityModule',
          [admin.address],
        ),
        chainId: evmChainId,
      };

      await expect(submitter.submit(tx)).to.be.rejectedWith(
        `function role ${UNGRANTED_ROLE}, caller is member: false, execution delay: 0s`,
      );
      expect(proposer.submitted).to.have.lengthOf(0);
    });

    it('should throw when the operation is already scheduled', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter(admin.address);
      const tx = handleTx(delayedRecipient, '0x03');
      await submitter.submit(tx);

      await expect(submitter.submit(tx)).to.be.rejectedWith(
        'is already scheduled for caller',
      );
    });

    it('should accept multiple selectors on the same target and preserve the input order', async () => {
      const proposer = new CapturingSubmitter();
      const submitter = await getCapturingAccessManagerSubmitter(
        proposer,
        admin.address,
      );
      const txs = [
        fooBarTx(delayedRecipient, 'first'),
        handleTx(immediateRecipient, '0x04'),
        handleTx(delayedRecipient, '0x05'),
      ];

      const { deferred } = splitOutput(await submitter.submit(...txs));

      expect(
        proposer.submitted.map((tx) => {
          const { name, args } = decode(tx);
          return [name, args[1]];
        }),
      ).to.deep.equal([
        ['schedule', txs[0].data],
        ['schedule', txs[2].data],
      ]);
      expect(proposer.submitted.every((tx) => tx.value === undefined)).to.be
        .true;
      expect(
        deferred.map((tx) => {
          const { name, args } = decode(tx);
          return [name, args[1]];
        }),
      ).to.deep.equal([
        ['execute', txs[0].data],
        ['execute', txs[1].data],
        ['execute', txs[2].data],
      ]);
      expect(deferred[0].value).to.be.undefined;
      expect(BigNumber.from(deferred[1].value).eq(VALUE)).to.be.true;
      expect(BigNumber.from(deferred[2].value).eq(VALUE)).to.be.true;
    });

    interface CallOrderCase {
      name: string;
      buildTxs: () => AnnotatedEV5Transaction[];
      expectedProposerCalls: Array<[string, number]>;
      expectedDeferredCalls: number[];
    }

    const callOrderCases: CallOrderCase[] = [
      {
        name: 'execute all calls right away when all are immediate',
        buildTxs: () => [
          handleTx(immediateRecipient, '0x0d'),
          handleTx(immediateRecipient, '0x0e'),
        ],
        expectedProposerCalls: [
          ['execute', 0],
          ['execute', 1],
        ],
        expectedDeferredCalls: [],
      },
      {
        name: 'execute an immediate call that precedes a delayed one',
        buildTxs: () => [
          handleTx(immediateRecipient, '0x0f'),
          fooBarTx(delayedRecipient, 'delayed'),
        ],
        expectedProposerCalls: [
          ['execute', 0],
          ['schedule', 1],
        ],
        expectedDeferredCalls: [1],
      },
      {
        name: 'defer an immediate call that follows a delayed one',
        buildTxs: () => [
          fooBarTx(delayedRecipient, 'delayed'),
          handleTx(immediateRecipient, '0x10'),
        ],
        expectedProposerCalls: [['schedule', 0]],
        expectedDeferredCalls: [0, 1],
      },
    ];

    for (const testCase of callOrderCases) {
      it(`should ${testCase.name}`, async () => {
        const proposer = new CapturingSubmitter();
        const submitter = await getCapturingAccessManagerSubmitter(
          proposer,
          admin.address,
        );
        const txs = testCase.buildTxs();

        const { deferred } = splitOutput(await submitter.submit(...txs));

        expect(
          proposer.submitted.map((tx) => {
            const { name, args } = decode(tx);
            return [name, args[1]];
          }),
        ).to.deep.equal(
          testCase.expectedProposerCalls.map(([name, index]) => [
            name,
            txs[index].data,
          ]),
        );
        expect(
          deferred.map((tx) => {
            const { name, args } = decode(tx);
            return [name, args[1]];
          }),
        ).to.deep.equal(
          testCase.expectedDeferredCalls.map((index) => [
            'execute',
            txs[index].data,
          ]),
        );
      });
    }

    it('should only schedule a delayed call followed by an immediate one and execute both in order after the delay', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter(admin.address);
      const txs = [
        fooBarTx(delayedRecipient, 'delayed'),
        handleTx(immediateRecipient, '0x11'),
      ];

      const { receipts, deferred } = splitOutput(
        await submitter.submit(...txs),
      );

      expect(receipts).to.have.lengthOf(1);
      const scheduleTx = await provider.getTransaction(
        receipts[0].transactionHash,
      );
      const decodedSchedule = decode(scheduleTx);
      expect(decodedSchedule.name).to.equal('schedule');
      expect(decodedSchedule.args[1]).to.equal(txs[0].data);
      expect(await delayedRecipient.lastCallMessage()).to.equal('');
      expect(await immediateRecipient.lastData()).to.equal('0x');
      expect(deferred.map((tx) => decode(tx).args[1])).to.deep.equal([
        txs[0].data,
        txs[1].data,
      ]);

      await increaseTime(EXECUTION_DELAY);
      for (const executeTx of deferred) {
        await (await admin.sendTransaction(toTxRequest(executeTx))).wait();
      }

      expect(await delayedRecipient.lastCallMessage()).to.equal('delayed');
      expect(await immediateRecipient.lastData()).to.equal('0x11');
      expect((await provider.getBalance(immediateRecipient.address)).eq(VALUE))
        .to.be.true;
    });

    it('should defer immediate calls in later submit calls on an instance that has scheduled a call', async () => {
      const proposer = new CapturingSubmitter();
      const submitter = await getCapturingAccessManagerSubmitter(
        proposer,
        admin.address,
      );
      const delayedTx = fooBarTx(delayedRecipient, 'delayed');
      const immediateTx = handleTx(immediateRecipient, '0x12');

      await submitter.submit(delayedTx);
      expect(proposer.submitted).to.have.lengthOf(1);
      const { deferred } = splitOutput(await submitter.submit(immediateTx));

      expect(proposer.submitCalls).to.equal(1);
      expect(proposer.submitted.map((tx) => decode(tx).name)).to.deep.equal([
        'schedule',
      ]);
      expect(
        deferred.map((tx) => {
          const { name, args } = decode(tx);
          return [name, args[1]];
        }),
      ).to.deep.equal([['execute', immediateTx.data]]);
      expect(BigNumber.from(deferred[0].value).eq(VALUE)).to.be.true;

      const freshProposer = new CapturingSubmitter();
      const freshSubmitter = await getCapturingAccessManagerSubmitter(
        freshProposer,
        admin.address,
      );
      const { deferred: freshDeferred } = splitOutput(
        await freshSubmitter.submit(immediateTx),
      );

      expect(
        freshProposer.submitted.map((tx) => {
          const { name, args } = decode(tx);
          return [name, args[1]];
        }),
      ).to.deep.equal([['execute', immediateTx.data]]);
      expect(freshDeferred).to.have.lengthOf(0);
    });
  });

  describe('without caller', () => {
    it('should always schedule, even for calls the proposer could execute immediately', async () => {
      const proposer = new CapturingSubmitter();
      const submitter = await getCapturingAccessManagerSubmitter(proposer);
      const tx = handleTx(immediateRecipient, '0x06');

      const { deferred } = splitOutput(await submitter.submit(tx));

      expect(proposer.submitted).to.have.lengthOf(1);
      const [scheduleTx] = proposer.submitted;
      expect(decode(scheduleTx).name).to.equal('schedule');
      expect(scheduleTx.value).to.be.undefined;
      expect(scheduleTx.from).to.be.undefined;
      expect(deferred).to.have.lengthOf(1);
      const [executeTx] = deferred;
      expect(decode(executeTx).name).to.equal('execute');
      expect(BigNumber.from(executeTx.value).eq(VALUE)).to.be.true;
      expect(executeTx.from).to.be.undefined;
    });

    it('should schedule on-chain for a delayed proposer', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter();
      const tx = handleTx(delayedRecipient, '0x07');

      const { receipts, deferred } = splitOutput(await submitter.submit(tx));

      expect(receipts).to.have.lengthOf(1);
      expect(deferred).to.have.lengthOf(1);
      assert(tx.to && tx.data, 'Expected tx target and data');
      const operationId = await accessManager.hashOperation(
        admin.address,
        tx.to,
        tx.data,
      );
      expect(await accessManager.getSchedule(operationId)).to.be.greaterThan(0);
    });

    it('should revert on-chain when the proposer has no execution delay', async () => {
      const submitter = await getJsonRpcAccessManagerSubmitter();

      await expect(
        submitter.submit(handleTx(immediateRecipient, '0x08')),
      ).to.be.rejectedWith(
        customErrorSelector('AccessManagerUnauthorizedCall'),
      );
      expect(await immediateRecipient.lastData()).to.equal('0x');
    });
  });

  interface InvalidInputCase {
    name: string;
    buildTxs: () => Promise<AnnotatedEV5Transaction[]>;
    expectedError: string;
  }

  const invalidInputCases: InvalidInputCase[] = [
    {
      name: 'a closed target',
      buildTxs: async () => {
        await (
          await accessManager.setTargetClosed(delayedRecipient.address, true)
        ).wait();
        return [handleTx(delayedRecipient, '0x09')];
      },
      expectedError: 'is closed on AccessManager',
    },
    {
      name: 'a call to the AccessManager itself',
      buildTxs: async () => [
        {
          to: accessManager.address,
          data: accessManagerInterface.encodeFunctionData('setTargetClosed', [
            delayedRecipient.address,
            true,
          ]),
          chainId: evmChainId,
        },
      ],
      expectedError: 'itself are not supported',
    },
    {
      name: 'a transaction for another chain',
      buildTxs: async () => [handleTx(delayedRecipient, '0x0a', 1)],
      expectedError: 'AccessManager transaction chainId 1 does not match',
    },
    {
      name: 'duplicate (target, data) pairs',
      buildTxs: async () => [
        handleTx(delayedRecipient, '0x0b'),
        handleTx(delayedRecipient, '0x0b'),
      ],
      expectedError: 'Duplicate AccessManager call',
    },
    {
      name: 'data shorter than a function selector',
      buildTxs: async () => [
        { to: delayedRecipient.address, data: '0x1234', chainId: evmChainId },
      ],
      expectedError: 'must contain at least a function selector',
    },
  ];

  const callerModes: Array<{
    name: string;
    getCaller: () => Address | undefined;
  }> = [
    { name: 'with caller', getCaller: () => admin.address },
    { name: 'without caller', getCaller: () => undefined },
  ];

  for (const callerMode of callerModes) {
    describe(`input validation ${callerMode.name}`, () => {
      for (const testCase of invalidInputCases) {
        it(`should reject ${testCase.name} before submitting anything`, async () => {
          const proposer = new CapturingSubmitter();
          const submitter = await getCapturingAccessManagerSubmitter(
            proposer,
            callerMode.getCaller(),
          );

          await expect(
            submitter.submit(...(await testCase.buildTxs())),
          ).to.be.rejectedWith(testCase.expectedError);
          expect(proposer.submitted).to.have.lengthOf(0);
        });
      }

      it('should accept transactions labelled with the domain id and emit the EVM chain id', async () => {
        const proposer = new CapturingSubmitter();
        const submitter = await getCapturingAccessManagerSubmitter(
          proposer,
          callerMode.getCaller(),
        );

        const { deferred } = splitOutput(
          await submitter.submit(handleTx(delayedRecipient, '0x0c', DOMAIN_ID)),
        );

        expect(proposer.submitted).to.have.lengthOf(1);
        expect(proposer.submitted[0].chainId).to.equal(evmChainId);
        expect(deferred).to.have.lengthOf(1);
        expect(deferred[0].chainId).to.equal(evmChainId);
      });

      it('should return an empty array when there are no transactions', async () => {
        const proposer = new CapturingSubmitter();
        const submitter = await getCapturingAccessManagerSubmitter(
          proposer,
          callerMode.getCaller(),
        );

        expect(await submitter.submit()).to.deep.equal([]);
        expect(proposer.submitted).to.have.lengthOf(0);
      });
    });
  }
});
