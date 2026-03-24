import {
  type Address,
  type Hex,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  toHex,
  zeroAddress,
} from 'viem';

import type { Permit2Data, SubmitQuoteCommand } from './types.js';
import { QuotedCallsCommand } from './types.js';

/**
 * Sentinel value: resolves to the contract's token balance (ERC20) or
 * native balance (ETH) at execution time. Matches QuotedCalls.CONTRACT_BALANCE.
 */
export const CONTRACT_BALANCE = 2n ** 255n;

// ============ SignedQuote ABI tuple ============
// Matches: abi.decode(input, (address, SignedQuote, bytes, bytes32))
// SignedQuote = (bytes context, bytes data, uint48 issuedAt, uint48 expiry, bytes32 salt, address submitter)

const signedQuoteTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'context', type: 'bytes' as const },
    { name: 'data', type: 'bytes' as const },
    { name: 'issuedAt', type: 'uint48' as const },
    { name: 'expiry', type: 'uint48' as const },
    { name: 'salt', type: 'bytes32' as const },
    { name: 'submitter', type: 'address' as const },
  ],
};

// ============ Permit2 PermitSingle ABI tuple ============
// Matches: abi.decode(input, (IAllowanceTransfer.PermitSingle, bytes))

const permitDetailsTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'token', type: 'address' as const },
    { name: 'amount', type: 'uint160' as const },
    { name: 'expiration', type: 'uint48' as const },
    { name: 'nonce', type: 'uint48' as const },
  ],
};

const permitSingleTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'details', ...permitDetailsTuple },
    { name: 'spender', type: 'address' as const },
    { name: 'sigDeadline', type: 'uint256' as const },
  ],
};

// ============ Per-command input encoders ============

/** Encode SUBMIT_QUOTE input: abi.encode(address quoter, SignedQuote quote, bytes signature, bytes32 clientSalt) */
export function encodeSubmitQuoteInput(
  cmd: SubmitQuoteCommand,
  clientSalt: Hex,
): Hex {
  return encodeAbiParameters(
    [
      { type: 'address' },
      signedQuoteTuple,
      { type: 'bytes' },
      { type: 'bytes32' },
    ],
    [
      cmd.quoter,
      {
        context: cmd.quote.context,
        data: cmd.quote.data,
        issuedAt: cmd.quote.issuedAt,
        expiry: cmd.quote.expiry,
        salt: cmd.quote.salt,
        submitter: cmd.quote.submitter,
      },
      cmd.signature,
      clientSalt,
    ],
  );
}

/** Encode PERMIT2_PERMIT input: abi.encode(IAllowanceTransfer.PermitSingle, bytes signature) */
export function encodePermit2PermitInput(permit2Data: Permit2Data): Hex {
  const { permitSingle, signature } = permit2Data;
  return encodeAbiParameters(
    [permitSingleTuple, { type: 'bytes' }],
    [
      {
        details: {
          token: permitSingle.details.token,
          amount: permitSingle.details.amount,
          expiration: permitSingle.details.expiration,
          nonce: permitSingle.details.nonce,
        },
        spender: permitSingle.spender,
        sigDeadline: BigInt(permitSingle.sigDeadline),
      },
      signature,
    ],
  );
}

/** Encode PERMIT2_TRANSFER_FROM input: abi.encode(address token, uint160 amount) */
export function encodePermit2TransferFromInput(
  token: Address,
  amount: bigint,
): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint160' }],
    [token, amount],
  );
}

/** Encode TRANSFER_FROM input: abi.encode(address token, uint256 amount) */
export function encodeTransferFromInput(token: Address, amount: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [token, amount],
  );
}

/** Encode TRANSFER_REMOTE input: abi.encode(address warpRoute, uint32 destination, bytes32 recipient, uint256 amount, uint256 value, address token, uint256 approval) */
export function encodeTransferRemoteInput(params: {
  warpRoute: Address;
  destination: number;
  recipient: Hex;
  amount: bigint;
  value: bigint;
  token: Address;
  approval: bigint;
}): Hex {
  return encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [
      params.warpRoute,
      params.destination,
      params.recipient,
      params.amount,
      params.value,
      params.token,
      params.approval,
    ],
  );
}

/** Encode TRANSFER_REMOTE_TO input: abi.encode(address router, uint32 destination, bytes32 recipient, uint256 amount, bytes32 targetRouter, uint256 value, address token, uint256 approval) */
export function encodeTransferRemoteToInput(params: {
  router: Address;
  destination: number;
  recipient: Hex;
  amount: bigint;
  targetRouter: Hex;
  value: bigint;
  token: Address;
  approval: bigint;
}): Hex {
  return encodeAbiParameters(
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
    [
      params.router,
      params.destination,
      params.recipient,
      params.amount,
      params.targetRouter,
      params.value,
      params.token,
      params.approval,
    ],
  );
}

/** Encode SWEEP input: abi.encode(address token) */
export function encodeSweepInput(token: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }], [token]);
}

// ============ Execute calldata ============

// ============ ABI definitions ============

const quoteTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'token', type: 'address' as const },
    { name: 'amount', type: 'uint256' as const },
  ],
};

export const quotedCallsAbi = [
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
    outputs: [
      {
        name: 'results',
        type: 'tuple[][]' as const,
        components: quoteTuple.components,
      },
    ],
    stateMutability: 'nonpayable' as const,
  },
] as const;

// ============ Encode helpers ============

function encodeCommandsBytes(commands: QuotedCallsCommand[]): Hex {
  return concat(commands.map((c) => toHex(c, { size: 1 }))) as Hex;
}

/** Encode QuotedCalls.execute(commands, inputs) calldata */
export function encodeExecuteCalldata(
  commands: QuotedCallsCommand[],
  inputs: Hex[],
): Hex {
  return encodeFunctionData({
    abi: quotedCallsAbi,
    functionName: 'execute',
    args: [encodeCommandsBytes(commands), inputs],
  });
}

/** Encode QuotedCalls.quoteExecute(commands, inputs) calldata */
export function encodeQuoteExecuteCalldata(
  commands: QuotedCallsCommand[],
  inputs: Hex[],
): Hex {
  return encodeFunctionData({
    abi: quotedCallsAbi,
    functionName: 'quoteExecute',
    args: [encodeCommandsBytes(commands), inputs],
  });
}

// ============ Quote result types and decoding ============

export interface Quote {
  token: Address;
  amount: bigint;
}

/** Decode the return value of quoteExecute into Quote[][] */
export function decodeQuoteExecuteResult(data: Hex): Quote[][] {
  const [results] = decodeAbiParameters(
    [
      {
        type: 'tuple[][]',
        components: quoteTuple.components,
      },
    ],
    data,
  );
  return (results as Array<Array<{ token: Address; amount: bigint }>>).map(
    (perCommand) =>
      perCommand.map((q) => ({ token: q.token, amount: q.amount })),
  );
}

/** Sum Quote[][] into totals per token address */
export function sumQuotesByToken(results: Quote[][]): Map<Address, bigint> {
  const totals = new Map<Address, bigint>();
  for (const perCommand of results) {
    for (const q of perCommand) {
      totals.set(q.token, (totals.get(q.token) ?? 0n) + q.amount);
    }
  }
  return totals;
}

/** Extract native (address(0)) and ERC20 totals from quote results */
export function extractQuoteTotals(results: Quote[][]): {
  nativeValue: bigint;
  tokenTotals: Map<Address, bigint>;
} {
  const all = sumQuotesByToken(results);
  const nativeValue = all.get(zeroAddress) ?? 0n;
  all.delete(zeroAddress);
  return { nativeValue, tokenTotals: all };
}
