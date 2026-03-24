import { expect } from 'chai';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  zeroAddress,
} from 'viem';

import {
  CONTRACT_BALANCE,
  type Quote,
  decodeQuoteExecuteResult,
  encodeExecuteCalldata,
  encodePermit2PermitInput,
  encodePermit2TransferFromInput,
  encodeQuoteExecuteCalldata,
  encodeSubmitQuoteInput,
  encodeSweepInput,
  encodeTransferFromInput,
  encodeTransferRemoteInput,
  encodeTransferRemoteToInput,
  extractQuoteTotals,
  quotedCallsAbi,
} from './codec.js';
import type { Permit2Data, SubmitQuoteCommand } from './types.js';
import { QuotedCallsCommand } from './types.js';

const QUOTER = '0x1111111111111111111111111111111111111111' as const;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const WARP_ROUTE = '0x3333333333333333333333333333333333333333' as const;
const RECIPIENT =
  '0x0000000000000000000000004444444444444444444444444444444444444444' as const;
const CLIENT_SALT =
  '0x5555555555555555555555555555555555555555555555555555555555555555' as const;
const SIGNATURE = '0xaabbccdd' as const;

const MOCK_QUOTE: SubmitQuoteCommand = {
  quoter: QUOTER,
  quote: {
    context: '0xdeadbeef',
    data: '0xcafebabe',
    issuedAt: 1000,
    expiry: 1000,
    salt: CLIENT_SALT,
    submitter: '0x6666666666666666666666666666666666666666',
  },
  signature: SIGNATURE,
};

describe('QuotedCalls codec', () => {
  describe('encodeSubmitQuoteInput', () => {
    it('round-trips through ABI decode', () => {
      const encoded = encodeSubmitQuoteInput(MOCK_QUOTE, CLIENT_SALT);
      const [quoter, quote, signature, clientSalt] = decodeAbiParameters(
        [
          { type: 'address' },
          {
            type: 'tuple',
            components: [
              { name: 'context', type: 'bytes' },
              { name: 'data', type: 'bytes' },
              { name: 'issuedAt', type: 'uint48' },
              { name: 'expiry', type: 'uint48' },
              { name: 'salt', type: 'bytes32' },
              { name: 'submitter', type: 'address' },
            ],
          },
          { type: 'bytes' },
          { type: 'bytes32' },
        ],
        encoded,
      );
      expect(quoter.toLowerCase()).to.equal(QUOTER);
      expect(quote.context).to.equal(MOCK_QUOTE.quote.context);
      expect(quote.data).to.equal(MOCK_QUOTE.quote.data);
      expect(Number(quote.issuedAt)).to.equal(MOCK_QUOTE.quote.issuedAt);
      expect(Number(quote.expiry)).to.equal(MOCK_QUOTE.quote.expiry);
      expect(quote.salt).to.equal(MOCK_QUOTE.quote.salt);
      expect(quote.submitter.toLowerCase()).to.equal(
        MOCK_QUOTE.quote.submitter,
      );
      expect(signature).to.equal(SIGNATURE);
      expect(clientSalt).to.equal(CLIENT_SALT);
    });
  });

  describe('encodeTransferFromInput', () => {
    it('encodes token and amount', () => {
      const encoded = encodeTransferFromInput(TOKEN, 1000n);
      const [token, amount] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        encoded,
      );
      expect(token.toLowerCase()).to.equal(TOKEN);
      expect(amount).to.equal(1000n);
    });
  });

  describe('encodePermit2TransferFromInput', () => {
    it('encodes token and uint160 amount', () => {
      const encoded = encodePermit2TransferFromInput(TOKEN, 500n);
      const [token, amount] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint160' }],
        encoded,
      );
      expect(token.toLowerCase()).to.equal(TOKEN);
      expect(amount).to.equal(500n);
    });
  });

  describe('encodePermit2PermitInput', () => {
    it('encodes PermitSingle and signature', () => {
      const permit2Data: Permit2Data = {
        permitSingle: {
          details: {
            token: TOKEN,
            amount: 1000n,
            expiration: 9999,
            nonce: 0,
          },
          spender: WARP_ROUTE,
          sigDeadline: 9999,
        },
        signature: SIGNATURE,
      };
      const encoded = encodePermit2PermitInput(permit2Data);
      // Should encode without error and produce valid hex
      expect(encoded).to.match(/^0x/);
      expect(encoded.length).to.be.greaterThan(10);
    });
  });

  describe('encodeTransferRemoteInput', () => {
    it('encodes all 7 fields', () => {
      const encoded = encodeTransferRemoteInput({
        warpRoute: WARP_ROUTE,
        destination: 42161,
        recipient: RECIPIENT,
        amount: CONTRACT_BALANCE,
        value: CONTRACT_BALANCE,
        token: TOKEN,
        approval: CONTRACT_BALANCE,
      });
      const decoded = decodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        encoded,
      );
      expect(decoded[0].toLowerCase()).to.equal(WARP_ROUTE);
      expect(Number(decoded[1])).to.equal(42161);
      expect(decoded[2]).to.equal(RECIPIENT);
      expect(decoded[3]).to.equal(CONTRACT_BALANCE);
      expect(decoded[4]).to.equal(CONTRACT_BALANCE);
      expect(decoded[5].toLowerCase()).to.equal(TOKEN);
      expect(decoded[6]).to.equal(CONTRACT_BALANCE);
    });
  });

  describe('encodeTransferRemoteToInput', () => {
    it('encodes all 8 fields with targetRouter', () => {
      const targetRouter =
        '0x0000000000000000000000007777777777777777777777777777777777777777' as const;
      const encoded = encodeTransferRemoteToInput({
        router: WARP_ROUTE,
        destination: 10,
        recipient: RECIPIENT,
        amount: 1000n,
        targetRouter,
        value: 500n,
        token: TOKEN,
        approval: 1000n,
      });
      const decoded = decodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        encoded,
      );
      expect(Number(decoded[1])).to.equal(10);
      expect(decoded[4]).to.equal(targetRouter);
    });
  });

  describe('encodeSweepInput', () => {
    it('encodes token address', () => {
      const encoded = encodeSweepInput(TOKEN);
      const [token] = decodeAbiParameters([{ type: 'address' }], encoded);
      expect(token.toLowerCase()).to.equal(TOKEN);
    });

    it('encodes zero address for ETH-only sweep', () => {
      const encoded = encodeSweepInput(zeroAddress);
      const [token] = decodeAbiParameters([{ type: 'address' }], encoded);
      expect(token).to.equal(zeroAddress);
    });
  });

  describe('encodeExecuteCalldata', () => {
    it('encodes commands and inputs into execute calldata', () => {
      const commands = [
        QuotedCallsCommand.TRANSFER_FROM,
        QuotedCallsCommand.SWEEP,
      ];
      const inputs = [
        encodeTransferFromInput(TOKEN, 1000n),
        encodeSweepInput(TOKEN),
      ];
      const calldata = encodeExecuteCalldata(commands, inputs);

      // Decode using the execute ABI
      const decoded = decodeFunctionData({
        abi: [
          {
            name: 'execute',
            type: 'function',
            inputs: [
              { name: 'commands', type: 'bytes' },
              { name: 'inputs', type: 'bytes[]' },
            ],
            outputs: [],
            stateMutability: 'payable',
          },
        ],
        data: calldata,
      });
      expect(decoded.functionName).to.equal('execute');
      // commands should be 2 bytes: 0x0308 (TRANSFER_FROM=0x03, SWEEP=0x08)
      expect(decoded.args[0]).to.equal('0x0308');
      expect(decoded.args[1]).to.have.length(2);
    });
  });

  describe('encodeQuoteExecuteCalldata', () => {
    it('encodes quoteExecute function selector', () => {
      const commands = [QuotedCallsCommand.TRANSFER_REMOTE];
      const inputs = [
        encodeTransferRemoteInput({
          warpRoute: TOKEN,
          destination: 42161,
          recipient: RECIPIENT,
          amount: 1000n,
          value: 0n,
          token: TOKEN,
          approval: 0n,
        }),
      ];
      const calldata = encodeQuoteExecuteCalldata(commands, inputs);

      const decoded = decodeFunctionData({
        abi: quotedCallsAbi,
        data: calldata,
      });
      expect(decoded.functionName).to.equal('quoteExecute');
    });
  });

  describe('decodeQuoteExecuteResult', () => {
    it('round-trips Quote[][] through encode/decode', () => {
      // Encode a Quote[][] as ABI return data (simulating quoteExecute return)
      const input: Quote[][] = [
        [], // SUBMIT_QUOTE → empty
        [
          { token: zeroAddress, amount: 100n },
          { token: TOKEN, amount: 1050n },
          { token: TOKEN, amount: 10n },
        ],
      ];
      const encoded = encodeAbiParameters(
        [
          {
            type: 'tuple[][]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
        ],
        [
          input.map((perCmd) =>
            perCmd.map((q) => ({ token: q.token, amount: q.amount })),
          ),
        ],
      );

      const decoded = decodeQuoteExecuteResult(encoded);

      expect(decoded).to.have.length(2);
      expect(decoded[0]).to.have.length(0);
      expect(decoded[1]).to.have.length(3);
      expect(decoded[1][0].token).to.equal(zeroAddress);
      expect(decoded[1][0].amount).to.equal(100n);
      expect(decoded[1][1].token.toLowerCase()).to.equal(TOKEN);
      expect(decoded[1][1].amount).to.equal(1050n);
      expect(decoded[1][2].amount).to.equal(10n);
    });

    it('decodes empty results', () => {
      const encoded = encodeAbiParameters(
        [
          {
            type: 'tuple[][]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
        ],
        [[]],
      );
      const decoded = decodeQuoteExecuteResult(encoded);
      expect(decoded).to.have.length(0);
    });
  });

  describe('extractQuoteTotals', () => {
    it('sums native and token fees separately', () => {
      const results: Quote[][] = [
        [],
        [
          { token: zeroAddress, amount: 100n },
          { token: TOKEN, amount: 1050n },
          { token: TOKEN, amount: 10n },
        ],
      ];
      const { nativeValue, tokenTotals } = extractQuoteTotals(results);
      expect(nativeValue).to.equal(100n);
      expect(tokenTotals.get(TOKEN)).to.equal(1060n);
      expect(tokenTotals.has(zeroAddress)).to.be.false;
    });

    it('returns zero for empty quotes', () => {
      const { nativeValue, tokenTotals } = extractQuoteTotals([[], []]);
      expect(nativeValue).to.equal(0n);
      expect(tokenTotals.size).to.equal(0);
    });
  });

  describe('CONTRACT_BALANCE', () => {
    it('equals 2^255', () => {
      expect(CONTRACT_BALANCE).to.equal(2n ** 255n);
    });
  });
});
