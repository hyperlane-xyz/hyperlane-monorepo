import { type Log, type TransactionReceipt } from '@ethersproject/providers';
import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, formatMessage } from '@hyperlane-xyz/utils';

import { type ExtendedSubmissionStrategy } from '../submitters/types.js';

import { canSelfRelay } from './relay.js';

const ORIGIN_CHAIN = 'anvil2';
const DESTINATION_CHAIN = 'anvil3';
const ORIGIN_DOMAIN = 31337;
const DESTINATION_DOMAIN = 31347;
const MAILBOX_ADDRESS = '0x0000000000000000000000000000000000000ab1';
const SENDER_ADDRESS = '0x0000000000000000000000000000000000000ab2';
const RECIPIENT_ADDRESS = '0x0000000000000000000000000000000000000ab3';
const ACCESS_MANAGER_ADDRESS = '0x0000000000000000000000000000000000000ab4';
const TIMELOCK_ADDRESS = '0x0000000000000000000000000000000000000ab5';
const SAFE_ADDRESS = '0x0000000000000000000000000000000000000ab6';
const REFUND_ADDRESS = '0x0000000000000000000000000000000000000ab7';
const TX_HASH = utils.hexZeroPad('0x01', 32);
const BLOCK_HASH = utils.hexZeroPad('0x02', 32);

function buildDispatchLog(): Log {
  const message = formatMessage(
    3,
    0,
    ORIGIN_DOMAIN,
    SENDER_ADDRESS,
    DESTINATION_DOMAIN,
    RECIPIENT_ADDRESS,
    '0x1234',
  );
  const { data, topics } = Mailbox__factory.createInterface().encodeEventLog(
    'Dispatch',
    [
      SENDER_ADDRESS,
      DESTINATION_DOMAIN,
      addressToBytes32(RECIPIENT_ADDRESS),
      message,
    ],
  );
  return {
    blockNumber: 1,
    blockHash: BLOCK_HASH,
    transactionIndex: 0,
    removed: false,
    address: MAILBOX_ADDRESS,
    data,
    topics,
    transactionHash: TX_HASH,
    logIndex: 0,
  };
}

function buildReceipt(logs: Log[]): TransactionReceipt {
  return {
    to: ACCESS_MANAGER_ADDRESS,
    from: SENDER_ADDRESS,
    contractAddress: '',
    transactionIndex: 0,
    gasUsed: BigNumber.from(100_000),
    logsBloom: '0x',
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logs,
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(100_000),
    effectiveGasPrice: BigNumber.from(1),
    byzantium: true,
    type: 2,
    status: 1,
  };
}

function buildIcaStrategy(
  internalSubmitter: Extract<
    ExtendedSubmissionStrategy['submitter'],
    { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
  >['internalSubmitter'],
): ExtendedSubmissionStrategy {
  return {
    submitter: {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: ORIGIN_CHAIN,
      destinationChain: DESTINATION_CHAIN,
      owner: ACCESS_MANAGER_ADDRESS,
      refundAddress: REFUND_ADDRESS,
      internalSubmitter,
    },
  };
}

const icaAccessManagerJsonRpcStrategy = buildIcaStrategy({
  type: TxSubmitterType.ACCESS_MANAGER,
  chain: ORIGIN_CHAIN,
  accessManagerAddress: ACCESS_MANAGER_ADDRESS,
  proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: ORIGIN_CHAIN },
});

describe('canSelfRelay', () => {
  it('should relay an ICA callRemote executed through an AccessManager with a jsonRpc proposer', () => {
    const receipt = buildReceipt([buildDispatchLog()]);

    const result = canSelfRelay(true, icaAccessManagerJsonRpcStrategy, [
      receipt,
    ]);

    expect(result).to.deep.equal({ relay: true, txReceipt: receipt });
  });

  interface NoRelayCase {
    name: string;
    selfRelay: boolean;
    strategy: ExtendedSubmissionStrategy;
    logs: Log[];
  }

  const noRelayCases: NoRelayCase[] = [
    {
      name: 'an ICA with a timelock internal submitter',
      selfRelay: true,
      strategy: buildIcaStrategy({
        type: TxSubmitterType.TIMELOCK_CONTROLLER,
        chain: ORIGIN_CHAIN,
        timelockAddress: TIMELOCK_ADDRESS,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: ORIGIN_CHAIN,
        },
      }),
      logs: [buildDispatchLog()],
    },
    {
      name: 'an ICA with an AccessManager internal submitter and a Safe proposer',
      selfRelay: true,
      strategy: buildIcaStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: ORIGIN_CHAIN,
        accessManagerAddress: ACCESS_MANAGER_ADDRESS,
        proposerSubmitter: {
          type: TxSubmitterType.GNOSIS_SAFE,
          chain: ORIGIN_CHAIN,
          safeAddress: SAFE_ADDRESS,
        },
      }),
      logs: [buildDispatchLog()],
    },
    {
      name: 'a receipt without a dispatched message',
      selfRelay: true,
      strategy: icaAccessManagerJsonRpcStrategy,
      logs: [],
    },
    {
      name: 'self relay disabled',
      selfRelay: false,
      strategy: icaAccessManagerJsonRpcStrategy,
      logs: [buildDispatchLog()],
    },
  ];

  for (const { name, selfRelay, strategy, logs } of noRelayCases) {
    it(`should not relay for ${name}`, () => {
      const result = canSelfRelay(selfRelay, strategy, [buildReceipt(logs)]);

      expect(result).to.deep.equal({ relay: false });
    });
  }
});
