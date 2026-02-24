import {
  concatHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  isHex,
  toEventSelector,
  toFunctionSelector,
  toHex,
} from 'viem';
import type {
  Abi,
  ContractFunctionName,
  ContractFunctionArgs,
  ContractFunctionReturnType,
  AbiEvent,
  AbiFunction,
  AbiParameter,
  Hex,
  Log,
  TransactionReceipt,
} from 'viem';

type ReadFunctionMutability = 'view' | 'pure';
type WriteFunctionMutability = 'nonpayable' | 'payable';
type AnyFunctionMutability = ReadFunctionMutability | WriteFunctionMutability;
type ReadFunctionNames<TAbi extends Abi> = ContractFunctionName<
  TAbi,
  ReadFunctionMutability
>;
type WriteFunctionNames<TAbi extends Abi> = ContractFunctionName<
  TAbi,
  WriteFunctionMutability
>;

type AnyFunctionNames<TAbi extends Abi> = ContractFunctionName<
  TAbi,
  AnyFunctionMutability
>;

export type TxRequestLike = Record<string, unknown>;

type UnknownAsyncMethod = (...args: readonly unknown[]) => Promise<never>;
export type ContractWriteResult = {
  hash: string;
  transactionHash?: string;
  wait: (
    confirmations?: number,
  ) => Promise<TransactionReceipt | Record<string, unknown>>;
} & Record<string, unknown>;

type ContractMethodArgs<
  TAbi extends Abi,
  TMutability extends AnyFunctionMutability,
  TName extends ContractFunctionName<TAbi, TMutability>,
> =
  ContractFunctionArgs<
    TAbi,
    TMutability,
    TName
  > extends infer TArgs extends readonly unknown[]
    ? [...TArgs, TxRequestLike?]
    : readonly unknown[];

export type ContractMethodMap<TAbi extends Abi> = {
  [TName in ReadFunctionNames<TAbi>]: (
    ...args: ContractMethodArgs<TAbi, ReadFunctionMutability, TName>
  ) => Promise<ContractFunctionReturnType<TAbi, ReadFunctionMutability, TName>>;
} & {
  [TName in WriteFunctionNames<TAbi>]: (
    ...args: ContractMethodArgs<TAbi, WriteFunctionMutability, TName>
  ) => Promise<ContractWriteResult>;
} & {
  [key: string]: UnknownAsyncMethod;
};

export type ContractEstimateGasMap<TAbi extends Abi> = {
  [TName in AnyFunctionNames<TAbi>]: (
    ...args: ContractMethodArgs<TAbi, AnyFunctionMutability, TName>
  ) => Promise<bigint>;
} & {
  [key: string]: (...args: readonly unknown[]) => Promise<bigint>;
};

type InterfaceFunctionEncoder = {
  name: string;
  signature: string;
  selector: Hex;
  inputs: readonly unknown[];
  encode: (args?: readonly unknown[]) => Hex;
};

type InterfaceEventFragment = {
  name: string;
  signature: string;
  topic: Hex;
};

export interface ViemInterface {
  abi: Abi;
  functions: Record<string, InterfaceFunctionEncoder>;
  events: Record<string, InterfaceEventFragment>;
  encodeFunctionData(functionName: string, args?: readonly unknown[]): Hex;
  encodeFilterTopics(
    eventNameOrFragment: string | InterfaceEventFragment,
    args?: readonly unknown[],
  ): readonly Hex[];
  decodeFunctionData(functionName: string, data: string): unknown[];
  getFunction(functionName: string): { inputs: readonly unknown[] };
  encodeFunctionResult(
    functionName: string,
    values: readonly unknown[],
  ): string;
  decodeFunctionResult(functionName: string, data: Hex): unknown;
  encodeDeploy(args?: readonly unknown[]): Hex;
  parseTransaction(tx: { data: string; value?: unknown }): {
    name: string;
    signature: string;
    sighash: string;
    functionFragment: {
      name: string;
      inputs: readonly unknown[];
    };
    args: readonly unknown[];
    value?: unknown;
  };
  parseLog(log: { data: string; topics: readonly string[] }): {
    name: string;
    event: string;
    args: unknown;
  };
  parseError(data: string): unknown;
  getEventTopic(eventNameOrSignature: string): Hex;
  getSighash(functionNameOrSignature: string): Hex;
}

export interface ArtifactEntry<TAbi extends Abi = Abi> {
  readonly contractName: string;
  readonly abi: TAbi;
  readonly bytecode: Hex;
}

type JsonRpcLike = {
  request: (args: {
    method: string;
    params?: readonly unknown[];
  }) => Promise<unknown>;
};

type SendLike = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

export type RunnerLike =
  | {
      provider?: unknown;
      request?: JsonRpcLike['request'];
      send?: (method: string, params: unknown[]) => Promise<unknown>;
      readContract?: (args: Record<string, unknown>) => Promise<unknown>;
      call?: (args: Record<string, unknown>) => Promise<unknown>;
      estimateContractGas?: (args: Record<string, unknown>) => Promise<unknown>;
      estimateGas?: (args: Record<string, unknown>) => Promise<unknown>;
      sendTransaction?: unknown;
      writeContract?: (args: Record<string, unknown>) => Promise<unknown>;
      waitForTransactionReceipt?: unknown;
      waitForTransaction?: unknown;
      getLogs?: (filter: Record<string, unknown>) => Promise<unknown[]>;
      getAddress?: () => Promise<string>;
    }
  | undefined;

export interface ViemContractLike<TAbi extends Abi = Abi> {
  address: string;
  interface: ViemInterface;
  estimateGas: ContractEstimateGasMap<TAbi>;
  functions: ContractMethodMap<TAbi>;
  queryFilter: <T = Record<string, unknown>>(
    filter: Record<string, unknown>,
    fromBlock?: unknown,
    toBlock?: unknown,
  ) => Promise<T[]>;
  connect: (runner: RunnerLike) => ViemContractLike<TAbi>;
  attach: (address: string) => ViemContractLike<TAbi>;
  signer: RunnerLike;
  provider: RunnerLike;
  deployTransaction?: {
    hash: string;
    data?: string;
    wait: (confirmations?: number) => Promise<unknown>;
  };
  deployed?: () => Promise<ViemContractLike<TAbi>>;
}

type SentTxLike = ContractWriteResult;
type WriteContractRequestLike = {
  address: string;
  abi: Abi;
  functionName: string;
} & Record<string, unknown>;

const TX_OVERRIDE_KEYS = new Set([
  'from',
  'to',
  'value',
  'gas',
  'gasLimit',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'type',
  'chainId',
  'blockTag',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function extractErrorMessages(
  error: unknown,
  seen: Set<unknown> = new Set(),
): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  if (typeof error === 'string') return [error];
  if (!isObject(error)) return [];

  const record = error as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of ['message', 'shortMessage', 'details', 'reason']) {
    const value = record[key];
    if (typeof value === 'string') messages.push(value);
  }

  if (Array.isArray(record.errors)) {
    for (const nestedError of record.errors) {
      messages.push(...extractErrorMessages(nestedError, seen));
    }
  }
  messages.push(...extractErrorMessages(record.error, seen));
  messages.push(...extractErrorMessages(record.cause, seen));
  return messages;
}

const SEND_FALLBACK_BLOCKERS = [
  /execution reverted/i,
  /revert/i,
  /insufficient funds/i,
  /nonce too low/i,
  /replacement transaction underpriced/i,
  /already known/i,
  /user rejected/i,
  /denied/i,
  /intrinsic gas too low/i,
  /out of gas/i,
  /gas required exceeds allowance/i,
  /fee cap less than block base fee/i,
];

const SEND_FALLBACK_REASONS = [
  /is not a function/i,
  /not implemented/i,
  /unsupported/i,
  /method .* not found/i,
  /invalid parameters were provided to the rpc method/i,
  /invalid argument/i,
  /invalid type:/i,
  /expected .* string/i,
  /missing value for required argument/i,
  /must provide (an )?account/i,
  /account is required/i,
];

const RECEIPT_RETRY_REASONS = [
  /invalid hash/i,
  /invalid transaction hash/i,
  /invalid argument/i,
  /invalid type:/i,
  /expected .* string/i,
  /missing value for required argument/i,
  /unsupported/i,
  /not implemented/i,
];

function shouldFallbackSend(error: unknown): boolean {
  const messages = extractErrorMessages(error);
  if (!messages.length) return false;
  if (
    messages.some((message) =>
      SEND_FALLBACK_BLOCKERS.some((pattern) => pattern.test(message)),
    )
  ) {
    return false;
  }
  return messages.some((message) =>
    SEND_FALLBACK_REASONS.some((pattern) => pattern.test(message)),
  );
}

function shouldRetryReceiptWithPositionalArgs(error: unknown): boolean {
  const messages = extractErrorMessages(error);
  return messages.some((message) =>
    RECEIPT_RETRY_REASONS.some((pattern) => pattern.test(message)),
  );
}

function getAccountAddress(account: unknown): string | undefined {
  if (typeof account === 'string') return account;
  if (isObject(account) && typeof account.address === 'string') {
    return account.address;
  }
  return undefined;
}

function getRunnerProvider(runner: RunnerLike): RunnerLike {
  if (!runner || !isObject(runner)) return undefined;
  if ('provider' in runner && isObject(runner.provider)) return runner.provider;
  return runner;
}

function getRpc(runner: RunnerLike): JsonRpcLike | undefined {
  if (!runner || !isObject(runner)) return undefined;
  if ('request' in runner && typeof runner.request === 'function') {
    return runner as unknown as JsonRpcLike;
  }
  const provider = getRunnerProvider(runner);
  if (
    provider &&
    isObject(provider) &&
    'request' in provider &&
    typeof provider.request === 'function'
  ) {
    return provider as unknown as JsonRpcLike;
  }
  return undefined;
}

function getSend(runner: RunnerLike): SendLike | undefined {
  if (!runner || !isObject(runner)) return undefined;
  if ('send' in runner && typeof runner.send === 'function') {
    return runner as unknown as SendLike;
  }
  const provider = getRunnerProvider(runner);
  if (
    provider &&
    isObject(provider) &&
    'send' in provider &&
    typeof provider.send === 'function'
  ) {
    return provider as unknown as SendLike;
  }
  return undefined;
}

async function rpcRequest(
  runner: RunnerLike,
  method: string,
  params: readonly unknown[] = [],
): Promise<unknown> {
  const rpc = getRpc(runner);
  if (rpc) return rpc.request({ method, params });
  const sender = getSend(runner);
  if (sender) return sender.send(method, [...params]);
  throw new Error(`No rpc transport for method ${method}`);
}

function toHexQuantity(value: unknown): Hex | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return toHex(value);
  if (typeof value === 'number') return toHex(BigInt(value));
  if (typeof value === 'string') {
    if (isHex(value)) return value as Hex;
    if (/^[0-9]+$/.test(value)) return toHex(BigInt(value));
  }
  return undefined;
}

type LogBlockTag =
  | 'latest'
  | 'earliest'
  | 'pending'
  | 'safe'
  | 'finalized';

function toLogBlockRef(value: unknown): Hex | LogBlockTag | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (
      value === 'latest' ||
      value === 'earliest' ||
      value === 'pending' ||
      value === 'safe' ||
      value === 'finalized'
    ) {
      return value;
    }
    if (isHex(value)) return value as Hex;
    if (/^[0-9]+$/.test(value)) return toHex(BigInt(value));
    return undefined;
  }
  return toHexQuantity(value);
}

function toBigIntValue(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return BigInt(value);
    if (/^[0-9]+$/.test(value)) return BigInt(value);
  }
  if (
    isObject(value) &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return toBigIntValue(value.toString(), label);
  }
  throw new Error(`Unable to convert ${label} result to bigint`);
}

function toReceiptLike(
  value: unknown,
  hash: string,
): TransactionReceipt | Record<string, unknown> {
  if (isObject(value)) {
    return value as TransactionReceipt | Record<string, unknown>;
  }
  throw new Error(`Transaction receipt not found for ${hash}`);
}

function isWriteContractRequest(
  request: TxRequestLike,
): request is WriteContractRequestLike {
  return (
    typeof request.address === 'string' &&
    Array.isArray(request.abi) &&
    typeof request.functionName === 'string'
  );
}

function splitArgsAndOverrides(
  args: readonly unknown[],
  inputCount: number,
): { fnArgs: unknown[]; overrides: Record<string, unknown> } {
  if (args.length <= inputCount) return { fnArgs: [...args], overrides: {} };
  if (args.length !== inputCount + 1) {
    return { fnArgs: [...args], overrides: {} };
  }
  const maybeOverrides = args[args.length - 1];
  if (
    isObject(maybeOverrides) &&
    (Object.keys(maybeOverrides).length === 0 ||
      Object.keys(maybeOverrides).some((key) => TX_OVERRIDE_KEYS.has(key)))
  ) {
    return {
      fnArgs: [...args.slice(0, args.length - 1)],
      overrides: maybeOverrides,
    };
  }
  return { fnArgs: [...args], overrides: {} };
}

function getFunctionAbi(
  abi: Abi,
  functionName: string,
): AbiFunction | undefined {
  if (functionName.includes('(')) {
    return abi.find((item): item is AbiFunction => {
      if (item.type !== 'function') return false;
      return getFunctionSignature(item) === functionName;
    });
  }

  const item = getAbiItem({
    abi,
    name: functionName,
  });
  if (!item || item.type !== 'function') return undefined;
  return item;
}

function getEventAbi(
  abi: Abi,
  eventNameOrSignature: string,
): AbiEvent | undefined {
  if (eventNameOrSignature.includes('(')) {
    return abi.find((item): item is AbiEvent => {
      if (item.type !== 'event') return false;
      return getEventSignature(item) === eventNameOrSignature;
    });
  }
  return abi.find(
    (item): item is AbiEvent =>
      item.type === 'event' && item.name === eventNameOrSignature,
  );
}

function getAbiParameterSignature(parameter: AbiParameter): string {
  if (!parameter.type.startsWith('tuple')) return parameter.type;
  const tupleSuffix = parameter.type.slice('tuple'.length);
  const tupleComponents =
    'components' in parameter && Array.isArray(parameter.components)
      ? parameter.components
      : [];
  const tupleFields = tupleComponents.map((component: AbiParameter) =>
    getAbiParameterSignature(component),
  );
  return `(${tupleFields.join(',')})${tupleSuffix}`;
}

function getFunctionSignature(fn: AbiFunction): string {
  return `${fn.name}(${(fn.inputs ?? [])
    .map((input) => getAbiParameterSignature(input))
    .join(',')})`;
}

function getFunctionSelector(fn: AbiFunction): Hex {
  return toFunctionSelector(getFunctionSignature(fn));
}

function getConstructorInputs(abi: Abi) {
  const ctor = abi.find((item) => item.type === 'constructor');
  if (!ctor || ctor.type !== 'constructor') return [];
  return ctor.inputs ?? [];
}

function normalizeFunctionArgs(
  fn: AbiFunction,
  fnArgs: readonly unknown[],
): unknown[] {
  return fnArgs.map((arg, index) => {
    const input = fn.inputs?.[index];
    if (
      input?.type === 'bytes32' &&
      typeof arg === 'string' &&
      isHex(arg) &&
      arg.length === 42
    ) {
      return `0x${arg.slice(2).padStart(64, '0')}`;
    }
    return arg;
  });
}

function getSingleFunctionAbi(fn: AbiFunction): Abi {
  return [fn];
}

function encodeFunctionCallData(
  fn: AbiFunction,
  args: readonly unknown[] = [],
): Hex {
  return encodeFunctionData({
    abi: getSingleFunctionAbi(fn),
    functionName: fn.name,
    args: normalizeFunctionArgs(fn, args),
  });
}

function buildInterfaceFunctions(abi: Abi) {
  const entries = abi.filter(
    (item): item is AbiFunction => item.type === 'function',
  );
  const functions: Record<string, InterfaceFunctionEncoder> = {};

  for (const fn of entries) {
    const signature = getFunctionSignature(fn);
    const selector = getFunctionSelector(fn);
    const fragment: InterfaceFunctionEncoder = {
      name: fn.name,
      signature,
      selector,
      inputs: [...(fn.inputs ?? [])],
      encode: (args = []) => encodeFunctionCallData(fn, args),
    };
    functions[signature] = fragment;
    if (!(fn.name in functions)) {
      functions[fn.name] = fragment;
    }
  }

  return functions;
}

function getFunctionAbiBySelector(
  abi: Abi,
  data: string,
): AbiFunction | undefined {
  if (!isHex(data) || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  return abi.find((item): item is AbiFunction => {
    if (item.type !== 'function') return false;
    return getFunctionSelector(item).toLowerCase() === selector;
  });
}

function getEventSignature(event: AbiEvent): string {
  return `${event.name}(${(event.inputs ?? [])
    .map((input) => getAbiParameterSignature(input))
    .join(',')})`;
}

function buildInterfaceEvents(abi: Abi) {
  const entries = abi.filter((item): item is AbiEvent => item.type === 'event');
  const events: Record<string, InterfaceEventFragment> = {};

  for (const event of entries) {
    const signature = getEventSignature(event);
    const fragment: InterfaceEventFragment = {
      name: event.name,
      signature,
      topic: toEventSelector(signature),
    };
    if (!(event.name in events)) {
      events[event.name] = fragment;
    }
    events[signature] = fragment;
  }

  return events;
}

function normalizeLogBlock(log: Record<string, unknown>) {
  const blockNumber = log.blockNumber;
  if (typeof blockNumber === 'string' && isHex(blockNumber)) {
    return BigInt(blockNumber);
  }
  return blockNumber;
}

export function createInterface<TAbi extends Abi>(
  abi: TAbi,
  bytecode?: Hex,
): ViemInterface {
  const functions = buildInterfaceFunctions(abi);
  const events = buildInterfaceEvents(abi);

  return {
    abi,
    functions,
    events,
    encodeFunctionData(functionName: string, args: readonly unknown[] = []) {
      const fn = getFunctionAbi(abi, functionName);
      if (!fn) {
        throw new Error(`Function ${functionName} not found`);
      }
      return encodeFunctionCallData(fn, args);
    },
    decodeFunctionData(functionName: string, data: string) {
      const fn = getFunctionAbi(abi, functionName);
      if (!fn) {
        throw new Error(`Function ${functionName} not found`);
      }
      const decoded = decodeFunctionData({
        abi: getSingleFunctionAbi(fn),
        data: data as Hex,
      });
      return (decoded.args ?? []) as unknown[];
    },
    getFunction(functionName: string) {
      const fn = getFunctionAbi(abi, functionName);
      if (!fn) {
        throw new Error(`Function ${functionName} not found`);
      }
      return { inputs: [...(fn.inputs ?? [])] };
    },
    encodeFunctionResult(functionName: string, values: readonly unknown[]) {
      const fn = getFunctionAbi(abi, functionName);
      if (!fn) {
        throw new Error(`Function ${functionName} not found`);
      }
      const outputs = fn.outputs ?? [];
      const normalizedResult =
        outputs.length === 0
          ? []
          : outputs.length === 1
            ? values[0]
            : [...values];
      return encodeFunctionResult({
        abi: getSingleFunctionAbi(fn),
        functionName: fn.name,
        result: normalizedResult,
      });
    },
    encodeFilterTopics(eventNameOrFragment, args = []) {
      const eventNameOrSignature =
        typeof eventNameOrFragment === 'string'
          ? eventNameOrFragment
          : eventNameOrFragment.signature;
      const event = getEventAbi(abi, eventNameOrSignature);
      if (!event) {
        throw new Error(`Event ${eventNameOrSignature} not found`);
      }
      return encodeEventTopics({
        abi: [event],
        eventName: event.name,
        args: args as readonly unknown[],
      });
    },
    decodeFunctionResult(functionName: string, data: Hex) {
      const fn = getFunctionAbi(abi, functionName);
      if (!fn) {
        throw new Error(`Function ${functionName} not found`);
      }
      return decodeFunctionResult({
        abi: getSingleFunctionAbi(fn),
        functionName: fn.name,
        data,
      });
    },
    encodeDeploy(args: readonly unknown[] = []) {
      if (!bytecode || bytecode === '0x') return bytecode ?? ('0x' as Hex);
      const inputs = getConstructorInputs(abi);
      if (!inputs.length) return bytecode;
      const encodedArgs = encodeAbiParameters(inputs, [...args]);
      return concatHex([bytecode, encodedArgs]);
    },
    parseTransaction(tx: { data: string; value?: unknown }) {
      const fn = getFunctionAbiBySelector(abi, tx.data);
      const parsed = decodeFunctionData({
        abi: fn ? getSingleFunctionAbi(fn) : abi,
        data: tx.data as Hex,
      });
      const parsedFn = fn ?? getFunctionAbi(abi, parsed.functionName);
      if (!parsedFn) {
        throw new Error(`Function ${parsed.functionName} not found`);
      }
      const signature = getFunctionSignature(parsedFn);
      const sighash = getFunctionSelector(parsedFn);
      return {
        name: parsed.functionName,
        signature,
        sighash,
        functionFragment: {
          name: parsedFn.name,
          inputs: [...(parsedFn.inputs ?? [])],
        },
        args: (parsed.args ?? []) as readonly unknown[],
        value: tx.value,
      };
    },
    parseLog(log: { data: string; topics: readonly string[] }) {
      const parsed = decodeEventLog({
        abi,
        data: log.data as Hex,
        topics: [...(log.topics as readonly Hex[])] as [Hex, ...Hex[]],
        strict: false,
      });
      return {
        name: parsed.eventName,
        event: parsed.eventName,
        args: parsed.args,
      };
    },
    parseError(data: string) {
      return decodeErrorResult({
        abi,
        data: data as Hex,
      });
    },
    getEventTopic(eventNameOrSignature: string) {
      if (eventNameOrSignature.includes('(')) {
        return toEventSelector(eventNameOrSignature);
      }
      const event = getEventAbi(abi, eventNameOrSignature);
      if (!event) {
        throw new Error(`Event ${eventNameOrSignature} not found`);
      }
      return toEventSelector(getEventSignature(event));
    },
    getSighash(functionNameOrSignature: string) {
      const fn = getFunctionAbi(abi, functionNameOrSignature);
      if (!fn) {
        throw new Error(`Function ${functionNameOrSignature} not found`);
      }
      return getFunctionSelector(fn);
    },
  } as ViemInterface;
}

async function performRead(
  runner: RunnerLike,
  address: string,
  fn: AbiFunction,
  args: readonly unknown[],
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const readAbi = getSingleFunctionAbi(fn);
  const from = typeof overrides.from === 'string' ? overrides.from : undefined;
  const blockRef = toLogBlockRef(overrides.blockTag) ?? 'latest';
  const blockTag =
    typeof blockRef === 'string' && !isHex(blockRef) ? blockRef : undefined;
  const blockNumber =
    typeof blockRef === 'string' && isHex(blockRef)
      ? BigInt(blockRef)
      : undefined;
  const provider = getRunnerProvider(runner);
  if (provider && isObject(provider)) {
    if (
      'readContract' in provider &&
      typeof provider.readContract === 'function'
    ) {
      const readRequest: Record<string, unknown> = {
        address,
        abi: readAbi,
        functionName: fn.name,
        args: [...args],
      };
      if (from) readRequest.account = from;
      if (blockTag) readRequest.blockTag = blockTag;
      if (blockNumber !== undefined) readRequest.blockNumber = blockNumber;
      return provider.readContract(readRequest);
    }
    if ('call' in provider && typeof provider.call === 'function') {
      const data = encodeFunctionCallData(fn, args);
      const callRequest: Record<string, unknown> = {
        to: address,
        data,
      };
      if (from) {
        callRequest.from = from;
        callRequest.account = from;
      }
      if (blockTag) callRequest.blockTag = blockTag;
      if (blockNumber !== undefined) callRequest.blockNumber = blockNumber;
      const callResult = await provider.call(callRequest);
      const callResultRecord = asRecord(callResult);
      const resultHex =
        typeof callResult === 'string'
          ? callResult
          : ((callResultRecord?.data as string | undefined) ?? '0x');
      return decodeFunctionResult({
        abi: readAbi,
        functionName: fn.name,
        data: resultHex as Hex,
      });
    }
  }

  const data = encodeFunctionCallData(fn, args);
  const rpcCallRequest: Record<string, unknown> = { to: address, data };
  if (from) rpcCallRequest.from = from;
  const callResult = await rpcRequest(runner, 'eth_call', [
    rpcCallRequest,
    blockRef,
  ]);
  return decodeFunctionResult({
    abi: readAbi,
    functionName: fn.name,
    data: callResult as Hex,
  });
}

async function performEstimateGas(
  runner: RunnerLike,
  request: TxRequestLike,
): Promise<bigint> {
  const provider = getRunnerProvider(runner);
  if (provider && isObject(provider)) {
    if (
      'estimateContractGas' in provider &&
      typeof provider.estimateContractGas === 'function'
    ) {
      return toBigIntValue(
        await provider.estimateContractGas(request),
        'estimateContractGas',
      );
    }
    if (
      'estimateGas' in provider &&
      typeof provider.estimateGas === 'function'
    ) {
      const estimate = await provider.estimateGas(request);
      return toBigIntValue(estimate, 'estimateGas');
    }
  }
  const estimated = await rpcRequest(runner, 'eth_estimateGas', [
    {
      ...request,
      value: toHexQuantity(request.value),
      gas: toHexQuantity(request.gas ?? request.gasLimit),
      gasPrice: toHexQuantity(request.gasPrice),
      maxFeePerGas: toHexQuantity(request.maxFeePerGas),
      maxPriorityFeePerGas: toHexQuantity(request.maxPriorityFeePerGas),
      nonce: toHexQuantity(request.nonce),
    },
  ]);
  return toBigIntValue(estimated, 'eth_estimateGas');
}

async function withRunnerFrom(
  runner: RunnerLike,
  request: TxRequestLike,
): Promise<TxRequestLike> {
  if (request.from) return request;
  if (
    runner &&
    isObject(runner) &&
    'getAddress' in runner &&
    typeof runner.getAddress === 'function'
  ) {
    try {
      const from = await (runner.getAddress as () => Promise<string>)();
      if (from) return { ...request, from };
    } catch {
      // noop: fallback to request without explicit from
    }
  }
  if (runner && isObject(runner) && 'account' in runner) {
    const from = getAccountAddress((runner as Record<string, unknown>).account);
    if (from) return { ...request, from };
  }
  const provider = getRunnerProvider(runner);
  if (provider && isObject(provider) && 'account' in provider) {
    const from = getAccountAddress(
      (provider as Record<string, unknown>).account,
    );
    if (from) return { ...request, from };
  }
  return request;
}

async function waitForReceipt(
  runner: RunnerLike,
  hash: string,
  confirmations?: number,
): Promise<TransactionReceipt | Record<string, unknown>> {
  const provider = getRunnerProvider(runner);
  if (provider && isObject(provider)) {
    if (
      'waitForTransactionReceipt' in provider &&
      typeof provider.waitForTransactionReceipt === 'function'
    ) {
      const waitForTransactionReceipt = provider.waitForTransactionReceipt as (
        arg0: unknown,
        confirmationsArg?: number,
        timeoutMs?: number,
      ) => Promise<unknown>;
      try {
        return toReceiptLike(
          await waitForTransactionReceipt({
            hash,
            confirmations,
          }),
          hash,
        );
      } catch (error) {
        if (!shouldRetryReceiptWithPositionalArgs(error)) {
          throw error;
        }
        return toReceiptLike(
          await waitForTransactionReceipt(hash, confirmations),
          hash,
        );
      }
    }
    if (
      'waitForTransaction' in provider &&
      typeof provider.waitForTransaction === 'function'
    ) {
      const waitForTransaction = provider.waitForTransaction as (
        txHash: string,
        confirmationsArg?: number,
      ) => Promise<unknown>;
      return toReceiptLike(await waitForTransaction(hash, confirmations), hash);
    }
  }

  const receipt = await rpcRequest(runner, 'eth_getTransactionReceipt', [hash]);
  if (!receipt) {
    throw new Error(`Transaction receipt not found for ${hash}`);
  }
  return toReceiptLike(receipt, hash);
}

function asTxResponse(runner: RunnerLike, tx: unknown): SentTxLike {
  const txRecord = isObject(tx) ? tx : {};
  const maybeWait = txRecord.wait;
  const wait =
    typeof maybeWait === 'function'
      ? (maybeWait as SentTxLike['wait'])
      : undefined;
  const hash =
    typeof tx === 'string'
      ? tx
      : ((txRecord.hash as string | undefined) ??
        (txRecord.transactionHash as string | undefined));
  if (!hash) {
    throw new Error('Unable to extract transaction hash from send result');
  }
  if (!wait) {
    return {
      ...txRecord,
      hash,
      wait: (confirmations?: number) =>
        waitForReceipt(runner, hash, confirmations),
    };
  }
  return {
    ...txRecord,
    hash,
    wait: async (confirmations?: number) => {
      try {
        return await wait(confirmations);
      } catch (error) {
        if (
          !shouldRetryReceiptWithPositionalArgs(error) &&
          !shouldFallbackSend(error)
        ) {
          throw error;
        }
        return waitForReceipt(runner, hash, confirmations);
      }
    },
  };
}

async function performSend(
  runner: RunnerLike,
  request: TxRequestLike,
): Promise<SentTxLike> {
  if (runner && isObject(runner)) {
    if (
      'writeContract' in runner &&
      typeof runner.writeContract === 'function' &&
      isWriteContractRequest(request)
    ) {
      try {
        const hash = await runner.writeContract(request);
        return asTxResponse(runner, hash);
      } catch (error) {
        if (!shouldFallbackSend(error)) throw error;
      }
    }

    const hasRunnerAddress =
      ('getAddress' in runner && typeof runner.getAddress === 'function') ||
      getAccountAddress((runner as Record<string, unknown>).account) !==
        undefined;
    if (
      'sendTransaction' in runner &&
      typeof runner.sendTransaction === 'function' &&
      hasRunnerAddress
    ) {
      try {
        const sent = await (
          runner.sendTransaction as (args: unknown) => Promise<unknown>
        )(request);
        return asTxResponse(runner, sent);
      } catch (error) {
        if (!shouldFallbackSend(error)) throw error;
      }
    }
  }

  const hash = await rpcRequest(runner, 'eth_sendTransaction', [
    await withRunnerFrom(runner, {
      ...request,
      value: toHexQuantity(request.value),
      gas: toHexQuantity(request.gas ?? request.gasLimit),
      gasPrice: toHexQuantity(request.gasPrice),
      maxFeePerGas: toHexQuantity(request.maxFeePerGas),
      maxPriorityFeePerGas: toHexQuantity(request.maxPriorityFeePerGas),
      nonce: toHexQuantity(request.nonce),
    }),
  ]);
  return asTxResponse(runner, hash);
}

async function performGetLogs(
  runner: RunnerLike,
  filter: Record<string, unknown>,
): Promise<Log[]> {
  const provider = getRunnerProvider(runner);
  if (provider && isObject(provider)) {
    if ('getLogs' in provider && typeof provider.getLogs === 'function') {
      return provider.getLogs(filter) as Promise<Log[]>;
    }
  }
  const logs = await rpcRequest(runner, 'eth_getLogs', [filter]);
  return logs as Log[];
}

function normalizeWriteResult(result: unknown): unknown {
  if (Array.isArray(result) && result.length === 1) return result[0];
  return result;
}

export function createContractProxy<TAbi extends Abi>(
  address: string,
  abi: TAbi,
  runner: RunnerLike,
): ViemContractLike<TAbi> {
  const iface = createInterface(abi);
  const callContractFunction = async (
    functionName: string,
    rawArgs: readonly unknown[],
  ) => {
    const fn = getFunctionAbi(abi, functionName);
    if (!fn) throw new Error(`Function ${functionName} not found`);
    const inputCount = (fn.inputs ?? []).length;
    const { fnArgs, overrides } = splitArgsAndOverrides(rawArgs, inputCount);
    const normalizedArgs = normalizeFunctionArgs(fn, fnArgs);
    const stateMutability = fn.stateMutability ?? 'nonpayable';
    if (stateMutability === 'view' || stateMutability === 'pure') {
      return performRead(runner, address, fn, normalizedArgs, overrides);
    }

    const request = await withRunnerFrom(runner, {
      to: address,
      data: encodeFunctionCallData(fn, normalizedArgs),
      ...overrides,
    });
    const response = await performSend(runner, request);
    return normalizeWriteResult(response);
  };

  const estimateGas = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return async (...rawArgs: unknown[]) => {
          const fn = getFunctionAbi(abi, prop);
          if (!fn) throw new Error(`Function ${prop} not found`);
          const inputCount = (fn.inputs ?? []).length;
          const { fnArgs, overrides } = splitArgsAndOverrides(
            rawArgs,
            inputCount,
          );
          const normalizedArgs = normalizeFunctionArgs(fn, fnArgs);
          const request = await withRunnerFrom(runner, {
            to: address,
            data: encodeFunctionCallData(fn, normalizedArgs),
            ...overrides,
          });
          return performEstimateGas(runner, request);
        };
      },
    },
  ) as ContractEstimateGasMap<TAbi>;

  const functions = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return (...args: unknown[]) => callContractFunction(prop, args);
      },
      has(_target, prop) {
        if (typeof prop !== 'string') return false;
        return !!getFunctionAbi(abi, prop);
      },
    },
  ) as ContractMethodMap<TAbi>;

  const contract = {
    address,
    signer: runner,
    provider: getRunnerProvider(runner),
    interface: iface,
    estimateGas,
    functions,
    async queryFilter(
      filter: Record<string, unknown>,
      fromBlock?: unknown,
      toBlock?: unknown,
    ) {
      const filterAddress = (filter.address as string | undefined) ?? address;
      const eventName = filter.eventName as string | undefined;
      const eventArgs = (filter.args as readonly unknown[] | undefined) ?? [];

      const abiItem = eventName ? getEventAbi(abi, eventName) : undefined;

      const topics =
        abiItem && abiItem.type === 'event'
          ? encodeEventTopics({
              abi: [abiItem],
              eventName: abiItem.name,
              args: eventArgs as readonly unknown[],
            })
          : (filter.topics as readonly Hex[] | undefined);

      const resolvedFromBlock = fromBlock ?? 0n;
      const logsFilter: Record<string, unknown> = {
        address: filterAddress,
        topics,
      };

      const fromBlockRef = toLogBlockRef(resolvedFromBlock);
      const toBlockRef = toLogBlockRef(toBlock);
      if (fromBlockRef !== undefined) logsFilter.fromBlock = fromBlockRef;
      if (toBlockRef !== undefined) logsFilter.toBlock = toBlockRef;

      const logs = await performGetLogs(runner, logsFilter);

      return logs
        .map((log) => {
          try {
            const decoded = decodeEventLog({
              abi,
              data: log.data,
              topics: log.topics,
              strict: false,
            });
            return {
              ...log,
              event: decoded.eventName,
              eventName: decoded.eventName,
              args: decoded.args,
              blockNumber: normalizeLogBlock(log as Record<string, unknown>),
            };
          } catch {
            return {
              ...log,
              blockNumber: normalizeLogBlock(log as Record<string, unknown>),
            };
          }
        })
        .filter(Boolean);
    },
    connect(nextRunner: RunnerLike) {
      return createContractProxy(address, abi, nextRunner);
    },
    attach(nextAddress: string) {
      return createContractProxy(nextAddress, abi, runner);
    },
  } as ViemContractLike<TAbi>;

  const contractProxy = new Proxy(contract, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);

      const fn = getFunctionAbi(abi, prop);
      if (!fn) return Reflect.get(target, prop, receiver);
      return (...rawArgs: unknown[]) => callContractFunction(prop, rawArgs);
    },
  }) as ViemContractLike<TAbi>;

  return contractProxy;
}

export class ViemContractFactory<
  TAbi extends Abi = Abi,
  TContract extends ViemContractLike<TAbi> = ViemContractLike<TAbi>,
> {
  static artifact: ArtifactEntry<Abi>;

  static get abi(): Abi {
    return this.artifact.abi;
  }

  static get bytecode(): Hex {
    return this.artifact.bytecode;
  }

  static createInterface<TAbi extends Abi>(this: {
    artifact: ArtifactEntry<TAbi>;
  }): ViemInterface {
    return createInterface(this.artifact.abi, this.artifact.bytecode);
  }

  static connect(
    this: { artifact: ArtifactEntry<Abi> },
    address: string,
    runner?: RunnerLike,
  ): unknown {
    return createContractProxy(address, this.artifact.abi, runner);
  }

  runner?: RunnerLike;

  constructor(runner?: RunnerLike) {
    this.runner = runner;
  }

  connect(runner: RunnerLike): this {
    const Ctor = this.constructor as new (runner?: RunnerLike) => this;
    return new Ctor(runner);
  }

  attach(address: string): TContract {
    return (
      this.constructor as unknown as {
        connect: (address: string, runner?: RunnerLike) => TContract;
      }
    ).connect(address, this.runner);
  }

  getDeployTransaction(...constructorArgs: readonly unknown[]): TxRequestLike {
    const iface = (
      this.constructor as typeof ViemContractFactory
    ).createInterface();
    return {
      data: iface.encodeDeploy(constructorArgs),
    } as TxRequestLike;
  }

  async deploy(...rawArgs: readonly unknown[]): Promise<TContract> {
    const ctorInputs = getConstructorInputs(
      (this.constructor as typeof ViemContractFactory).abi,
    );
    const { fnArgs, overrides } = splitArgsAndOverrides(
      rawArgs,
      ctorInputs.length,
    );
    const deployTx = await withRunnerFrom(this.runner, {
      ...this.getDeployTransaction(...fnArgs),
      ...overrides,
    });
    const txResponse = await performSend(this.runner, deployTx);
    const receipt = (await txResponse.wait()) as TransactionReceipt & {
      contractAddress?: string;
    };
    const contractAddress = receipt.contractAddress;
    if (!contractAddress) {
      throw new Error(
        `Deployment for ${
          (this.constructor as typeof ViemContractFactory).artifact.contractName
        } did not return contractAddress`,
      );
    }
    const contract = (
      this.constructor as unknown as {
        connect: (address: string, runner?: RunnerLike) => TContract;
      }
    ).connect(contractAddress, this.runner);
    const txHash =
      txResponse?.hash ??
      txResponse?.transactionHash ??
      '0x0000000000000000000000000000000000000000000000000000000000000000';
    contract.deployTransaction = {
      ...txResponse,
      hash: txHash,
      data: typeof deployTx.data === 'string' ? deployTx.data : undefined,
      wait: txResponse.wait,
    };
    contract.deployed = async () => {
      await txResponse.wait();
      return contract;
    };
    return contract;
  }
}
