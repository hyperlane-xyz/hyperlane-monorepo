import { expect } from 'chai';
import { decodeFunctionData, zeroAddress } from 'viem';

import { buildExecuteCalldata, buildQuoteCalldata } from './builder.js';
import type { Quote } from './codec.js';
import type { SubmitQuoteCommand } from './types.js';
import { QuotedCallsCommand, TokenPullMode } from './types.js';

const QUOTED_CALLS = '0x1111111111111111111111111111111111111111' as const;
const WARP_ROUTE = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const RECIPIENT =
  '0x0000000000000000000000004444444444444444444444444444444444444444' as const;
const CLIENT_SALT =
  '0x5555555555555555555555555555555555555555555555555555555555555555' as const;

const MOCK_QUOTE: SubmitQuoteCommand = {
  quoter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  quote: {
    context: '0xdeadbeef',
    data: '0xcafebabe',
    issuedAt: 1000,
    expiry: 1000,
    salt: CLIENT_SALT,
    submitter: QUOTED_CALLS,
  },
  signature: '0xaabb',
};

const BASE_PARAMS = {
  quotedCallsAddress: QUOTED_CALLS,
  warpRoute: WARP_ROUTE,
  destination: 42161,
  recipient: RECIPIENT,
  amount: 1000n,
  token: TOKEN,
  quotes: [MOCK_QUOTE],
  clientSalt: CLIENT_SALT,
};

const executeAbi = [
  {
    name: 'execute',
    type: 'function' as const,
    inputs: [
      { name: 'commands', type: 'bytes' as const },
      { name: 'inputs', type: 'bytes[]' as const },
    ],
    outputs: [],
    stateMutability: 'payable' as const,
  },
  {
    name: 'quoteExecute',
    type: 'function' as const,
    inputs: [
      { name: 'commands', type: 'bytes' as const },
      { name: 'inputs', type: 'bytes[]' as const },
    ],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
] as const;

function decodeCommands(data: `0x${string}`): {
  fn: string;
  commands: number[];
} {
  const decoded = decodeFunctionData({ abi: executeAbi, data });
  const commandsHex = (decoded.args[0] as string).slice(2);
  const commands: number[] = [];
  for (let i = 0; i < commandsHex.length; i += 2) {
    commands.push(parseInt(commandsHex.slice(i, i + 2), 16));
  }
  return { fn: decoded.functionName, commands };
}

// Mock fee quotes from quoteExecute
const MOCK_FEE_QUOTES: Quote[][] = [
  [], // SUBMIT_QUOTE → empty
  [
    // TRANSFER_REMOTE → 3 quotes
    { token: zeroAddress, amount: 100n }, // IGP native fee
    { token: TOKEN, amount: 1050n }, // amount + internal fee
    { token: TOKEN, amount: 10n }, // external fee
  ],
];

describe('buildQuoteCalldata', () => {
  it('builds quoteExecute with SUBMIT_QUOTE + TRANSFER_REMOTE', () => {
    const result = buildQuoteCalldata(BASE_PARAMS);

    expect(result.to).to.equal(QUOTED_CALLS);
    expect(result.value).to.equal(0n);

    const { fn, commands } = decodeCommands(result.data);
    expect(fn).to.equal('quoteExecute');
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.TRANSFER_REMOTE,
    ]);
  });

  it('builds quoteExecute with TRANSFER_REMOTE_TO for cross-collateral', () => {
    const targetRouter =
      '0x0000000000000000000000007777777777777777777777777777777777777777' as const;
    const result = buildQuoteCalldata({ ...BASE_PARAMS, targetRouter });

    const { commands } = decodeCommands(result.data);
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.TRANSFER_REMOTE_TO,
    ]);
  });
});

describe('buildExecuteCalldata', () => {
  it('builds ERC20 TransferFrom execute from fee quotes', () => {
    const result = buildExecuteCalldata({
      ...BASE_PARAMS,
      feeQuotes: MOCK_FEE_QUOTES,
      tokenPullMode: TokenPullMode.TransferFrom,
    });

    expect(result.to).to.equal(QUOTED_CALLS);
    // native value = IGP fee (100)
    expect(result.value).to.equal(100n);

    const { fn, commands } = decodeCommands(result.data);
    expect(fn).to.equal('execute');
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.TRANSFER_FROM,
      QuotedCallsCommand.TRANSFER_REMOTE,
      QuotedCallsCommand.SWEEP,
    ]);
  });

  it('builds Permit2 execute from fee quotes', () => {
    const result = buildExecuteCalldata({
      ...BASE_PARAMS,
      feeQuotes: MOCK_FEE_QUOTES,
      tokenPullMode: TokenPullMode.Permit2,
      permit2Data: {
        permitSingle: {
          details: {
            token: TOKEN,
            amount: 2000n,
            expiration: 9999,
            nonce: 0,
          },
          spender: QUOTED_CALLS,
          sigDeadline: 9999,
        },
        signature: '0xaabb',
      },
    });

    const { commands } = decodeCommands(result.data);
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.PERMIT2_PERMIT,
      QuotedCallsCommand.PERMIT2_TRANSFER_FROM,
      QuotedCallsCommand.TRANSFER_REMOTE,
      QuotedCallsCommand.SWEEP,
    ]);
  });

  it('builds native route execute (no TRANSFER_FROM)', () => {
    const nativeFeeQuotes: Quote[][] = [
      [],
      [{ token: zeroAddress, amount: 5100n }],
    ];
    const result = buildExecuteCalldata({
      ...BASE_PARAMS,
      token: zeroAddress,
      amount: 5000n,
      feeQuotes: nativeFeeQuotes,
      tokenPullMode: TokenPullMode.TransferFrom,
    });

    // msg.value = native total from quotes (5100 already includes transfer amount)
    expect(result.value).to.equal(5100n);

    const { commands } = decodeCommands(result.data);
    // No TRANSFER_FROM for native route
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.TRANSFER_REMOTE,
      QuotedCallsCommand.SWEEP,
    ]);
  });

  it('skips SWEEP for TransferFrom with zero token fees', () => {
    const zeroTokenFeeQuotes: Quote[][] = [
      [], // SUBMIT_QUOTE → empty
      [
        // TRANSFER_REMOTE → native fee only, no token fee
        { token: zeroAddress, amount: 100n },
      ],
    ];
    const result = buildExecuteCalldata({
      ...BASE_PARAMS,
      feeQuotes: zeroTokenFeeQuotes,
      tokenPullMode: TokenPullMode.TransferFrom,
    });

    const { commands } = decodeCommands(result.data);
    // No TRANSFER_FROM (totalTokenNeeded=0) and no SWEEP (TransferFrom + zero token fees)
    expect(commands).to.deep.equal([
      QuotedCallsCommand.SUBMIT_QUOTE,
      QuotedCallsCommand.TRANSFER_REMOTE,
    ]);
    expect(result.value).to.equal(100n);
  });

  it('throws when Permit2 mode without permit2Data', () => {
    expect(() =>
      buildExecuteCalldata({
        ...BASE_PARAMS,
        feeQuotes: MOCK_FEE_QUOTES,
        tokenPullMode: TokenPullMode.Permit2,
      }),
    ).to.throw('permit2Data required');
  });
});
