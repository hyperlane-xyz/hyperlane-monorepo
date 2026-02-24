import {
    concatHex,
    decodeErrorResult,
    decodeEventLog,
    decodeFunctionData,
    decodeFunctionResult,
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionData,
    getAbiItem,
    isHex,
    toEventSelector,
    toHex,
} from "viem";
import type {
    Abi,
    ContractEventName,
    ContractFunctionArgs,
    ContractFunctionName,
    ContractFunctionReturnType,
    AbiEvent,
    AbiFunction,
    AbiParameter,
    Hex,
    Log,
    TransactionReceipt,
} from "viem";

type ReadFunctionMutability = "view" | "pure";
type WriteFunctionMutability = "nonpayable" | "payable";
type AnyFunctionMutability =
    | ReadFunctionMutability
    | WriteFunctionMutability;

type ReadFunctionNames<TAbi extends Abi> = ContractFunctionName<
    TAbi,
    ReadFunctionMutability
>;
type AnyFunctionNames<TAbi extends Abi> = ContractFunctionName<
    TAbi,
    AnyFunctionMutability
>;

type MethodArgs<
    TAbi extends Abi,
    TMutability extends AnyFunctionMutability,
    TName extends ContractFunctionName<TAbi, TMutability>,
> = ContractFunctionArgs<TAbi, TMutability, TName> extends readonly unknown[]
    ? ContractFunctionArgs<TAbi, TMutability, TName>
    : readonly unknown[];

export type TxRequestLike = Record<string, unknown>;

export type ContractMethodMap<TAbi extends Abi> = {
    [TName in AnyFunctionNames<TAbi>]: (
        ...args: MethodArgs<TAbi, AnyFunctionMutability, TName>
    ) => Promise<
        TName extends ReadFunctionNames<TAbi>
            ? ContractFunctionReturnType<
                  TAbi,
                  ReadFunctionMutability,
                  TName
              >
            : unknown
    >;
};

export type ContractCallStaticMap<TAbi extends Abi> = {
    [TName in AnyFunctionNames<TAbi>]: (
        ...args: MethodArgs<TAbi, AnyFunctionMutability, TName>
    ) => Promise<ContractFunctionReturnType<TAbi, AnyFunctionMutability, TName>>;
};

export type ContractEstimateGasMap<TAbi extends Abi> = {
    [TName in AnyFunctionNames<TAbi>]: (
        ...args: MethodArgs<TAbi, AnyFunctionMutability, TName>
    ) => Promise<bigint>;
};

export type ContractPopulateTransactionMap<TAbi extends Abi> = {
    [TName in AnyFunctionNames<TAbi>]: (
        ...args: MethodArgs<TAbi, AnyFunctionMutability, TName>
    ) => Promise<TxRequestLike>;
};

export type ContractFilterMap<TAbi extends Abi> = {
    [TName in ContractEventName<TAbi>]: (
        ...args: readonly unknown[]
    ) => Record<string, unknown>;
};

type InterfaceFunctionEncoder = {
    encode: (args?: readonly unknown[]) => Hex;
};

export interface ViemInterface<TAbi extends Abi = Abi> {
    abi: TAbi;
    functions: Record<string, InterfaceFunctionEncoder>;
    encodeFunctionData(
        functionName: string,
        args?: readonly unknown[],
    ): Hex;
    decodeFunctionResult(functionName: string, data: Hex): unknown;
    encodeDeploy(args?: readonly unknown[]): Hex;
    parseTransaction(tx: {data: string; value?: unknown}): {
        name: string;
        args: readonly unknown[];
        value?: unknown;
    };
    parseLog(log: {data: string; topics: readonly string[]}): {
        name: string;
        event: string;
        args: unknown;
    };
    parseError(data: string): unknown;
    getEventTopic(eventNameOrSignature: string): Hex;
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
    send: (method: string, params?: readonly unknown[]) => Promise<unknown>;
};

export type RunnerLike =
    | ({
          provider?: Record<string, unknown>;
          request?: JsonRpcLike["request"];
          send?: SendLike["send"];
          readContract?: (args: Record<string, unknown>) => Promise<unknown>;
          call?: (args: Record<string, unknown>) => Promise<unknown>;
          estimateContractGas?: (
              args: Record<string, unknown>,
          ) => Promise<unknown>;
          estimateGas?: (args: Record<string, unknown>) => Promise<unknown>;
          sendTransaction?: (
              args: Record<string, unknown>,
          ) => Promise<unknown>;
          writeContract?: (args: Record<string, unknown>) => Promise<unknown>;
          waitForTransactionReceipt?: (args: {
              hash: string;
              confirmations?: number;
          }) => Promise<unknown>;
          waitForTransaction?: (
              hash: string,
              confirmations?: number,
          ) => Promise<unknown>;
          getLogs?: (filter: Record<string, unknown>) => Promise<Log[]>;
          getAddress?: () => Promise<string>;
      } & Record<string, unknown>)
    | undefined;

export interface ViemContractLike<TAbi extends Abi = Abi> {
    address: string;
    interface: ViemInterface<TAbi>;
    populateTransaction: ContractPopulateTransactionMap<TAbi>;
    callStatic: ContractCallStaticMap<TAbi>;
    estimateGas: ContractEstimateGasMap<TAbi>;
    filters: ContractFilterMap<TAbi>;
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
    [key: string]: unknown;
}

type SentTxLike = {
    hash: string;
    transactionHash?: string;
    wait: (confirmations?: number) => Promise<TransactionReceipt | Record<string, unknown>>;
} & Record<string, unknown>;

const TX_OVERRIDE_KEYS = new Set([
    "from",
    "to",
    "value",
    "gas",
    "gasLimit",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "type",
    "chainId",
    "blockTag",
]);

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isObject(value) ? value : undefined;
}

function getRunnerProvider(runner: RunnerLike): RunnerLike {
    if (!runner || !isObject(runner)) return undefined;
    if ("provider" in runner && isObject(runner.provider))
        return runner.provider;
    return runner;
}

function getRpc(runner: RunnerLike): JsonRpcLike | undefined {
    if (!runner || !isObject(runner)) return undefined;
    if ("request" in runner && typeof runner.request === "function") {
        return runner as unknown as JsonRpcLike;
    }
    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider) && "request" in provider) {
        return provider as unknown as JsonRpcLike;
    }
    return undefined;
}

function getSend(runner: RunnerLike): SendLike | undefined {
    if (!runner || !isObject(runner)) return undefined;
    if ("send" in runner && typeof runner.send === "function") {
        return runner as unknown as SendLike;
    }
    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider) && "send" in provider) {
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
    if (rpc) return rpc.request({method, params});
    const sender = getSend(runner);
    if (sender) return sender.send(method, params);
    throw new Error(`No rpc transport for method ${method}`);
}

function toHexQuantity(value: unknown): Hex | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "bigint") return toHex(value);
    if (typeof value === "number") return toHex(BigInt(value));
    if (typeof value === "string") {
        if (isHex(value)) return value as Hex;
        if (/^[0-9]+$/.test(value)) return toHex(BigInt(value));
    }
    return undefined;
}

function toBigIntValue(value: unknown, label: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") {
        if (value.startsWith("0x")) return BigInt(value);
        if (/^[0-9]+$/.test(value)) return BigInt(value);
    }
    if (
        isObject(value) &&
        "toString" in value &&
        typeof value.toString === "function"
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

function splitArgsAndOverrides(
    args: readonly unknown[],
    inputCount: number,
): {fnArgs: unknown[]; overrides: Record<string, unknown>} {
    if (args.length <= inputCount) return {fnArgs: [...args], overrides: {}};
    const maybeOverrides = args[args.length - 1];
    const looksLikeTrailingOverrides = args.length === inputCount + 1;
    if (looksLikeTrailingOverrides) {
        return {
            fnArgs: [...args.slice(0, args.length - 1)],
            overrides: isObject(maybeOverrides) ? maybeOverrides : {},
        };
    }
    if (
        isObject(maybeOverrides) &&
        (looksLikeTrailingOverrides ||
            Object.keys(maybeOverrides).some((key) =>
                TX_OVERRIDE_KEYS.has(key),
            ))
    ) {
        return {
            fnArgs: [...args.slice(0, args.length - 1)],
            overrides: maybeOverrides,
        };
    }
    return {fnArgs: [...args], overrides: {}};
}

function getFunctionAbi(
    abi: Abi,
    functionName: string,
): AbiFunction | undefined {
    if (functionName.includes("(")) {
        return abi.find((item): item is AbiFunction => {
            if (item.type !== "function") return false;
            return getFunctionSignature(item) === functionName;
        });
    }

    const item = getAbiItem({
        abi,
        name: functionName,
    });
    if (!item || item.type !== "function") return undefined;
    return item;
}

function getEventAbi(abi: Abi, eventNameOrSignature: string): AbiEvent | undefined {
    if (eventNameOrSignature.includes("(")) {
        return abi.find((item): item is AbiEvent => {
            if (item.type !== "event") return false;
            return getEventSignature(item) === eventNameOrSignature;
        });
    }
    return abi.find(
        (item): item is AbiEvent =>
            item.type === "event" && item.name === eventNameOrSignature,
    );
}

function getAbiParameterSignature(parameter: AbiParameter): string {
    if (!parameter.type.startsWith("tuple")) return parameter.type;
    const tupleSuffix = parameter.type.slice("tuple".length);
    const tupleComponents =
        "components" in parameter && Array.isArray(parameter.components)
            ? parameter.components
            : [];
    const tupleFields = tupleComponents.map((component: AbiParameter) =>
        getAbiParameterSignature(component),
    );
    return `(${tupleFields.join(",")})${tupleSuffix}`;
}

function getFunctionSignature(fn: AbiFunction): string {
    return `${fn.name}(${(fn.inputs ?? [])
        .map((input) => getAbiParameterSignature(input))
        .join(",")})`;
}

function getConstructorInputs(abi: Abi) {
    const ctor = abi.find((item) => item.type === "constructor");
    if (!ctor || ctor.type !== "constructor") return [];
    return ctor.inputs ?? [];
}

function normalizeFunctionArgs(
    fn: AbiFunction,
    fnArgs: readonly unknown[],
): unknown[] {
    return fnArgs.map((arg, index) => {
        const input = fn.inputs?.[index];
        if (
            input?.type === "bytes32" &&
            typeof arg === "string" &&
            isHex(arg) &&
            arg.length === 42
        ) {
            return `0x${arg.slice(2).padStart(64, "0")}`;
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
        (item): item is AbiFunction => item.type === "function",
    );
    const functions: Record<
        string,
        {encode: (args?: readonly unknown[]) => Hex}
    > = {};

    for (const fn of entries) {
        const signature = getFunctionSignature(fn);
        functions[signature] = {
            encode: (args = []) => encodeFunctionCallData(fn, args),
        };
    }

    return functions;
}

function getEventSignature(event: AbiEvent): string {
    return `${event.name}(${(event.inputs ?? [])
        .map((input) => getAbiParameterSignature(input))
        .join(",")})`;
}

function normalizeLogBlock(log: Record<string, unknown>) {
    const blockNumber = log.blockNumber;
    if (typeof blockNumber === "string" && isHex(blockNumber)) {
        return BigInt(blockNumber);
    }
    return blockNumber;
}

export function createInterface<TAbi extends Abi>(
    abi: TAbi,
    bytecode?: Hex,
): ViemInterface<TAbi> {
    const functions = buildInterfaceFunctions(abi);

    return {
        abi,
        functions,
        encodeFunctionData(
            functionName: string,
            args: readonly unknown[] = [],
        ) {
            const fn = getFunctionAbi(abi, functionName);
            if (!fn) {
                throw new Error(`Function ${functionName} not found`);
            }
            return encodeFunctionCallData(fn, args);
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
            if (!bytecode || bytecode === "0x")
                return bytecode ?? ("0x" as Hex);
            const inputs = getConstructorInputs(abi);
            if (!inputs.length) return bytecode;
            const encodedArgs = encodeAbiParameters(inputs, [...args]);
            return concatHex([bytecode, encodedArgs]);
        },
        parseTransaction(tx: {data: string; value?: unknown}) {
            const parsed = decodeFunctionData({
                abi,
                data: tx.data as Hex,
            });
            return {
                name: parsed.functionName,
                args: parsed.args ?? [],
                value: tx.value,
            };
        },
        parseLog(log: {data: string; topics: readonly string[]}) {
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
            if (eventNameOrSignature.includes("(")) {
                return toEventSelector(eventNameOrSignature);
            }
            const event = getEventAbi(abi, eventNameOrSignature);
            if (!event) {
                throw new Error(`Event ${eventNameOrSignature} not found`);
            }
            return toEventSelector(getEventSignature(event));
        },
    } as ViemInterface<TAbi>;
}

async function performRead(
    runner: RunnerLike,
    address: string,
    fn: AbiFunction,
    args: readonly unknown[],
): Promise<unknown> {
    const readAbi = getSingleFunctionAbi(fn);
    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider)) {
        if (
            "readContract" in provider &&
            typeof provider.readContract === "function"
        ) {
            return provider.readContract({
                address,
                abi: readAbi,
                functionName: fn.name,
                args: [...args],
            });
        }
        if ("call" in provider && typeof provider.call === "function") {
            const data = encodeFunctionCallData(fn, args);
            const callResult = await provider.call({
                to: address,
                data,
            });
            const callResultRecord = asRecord(callResult);
            const resultHex =
                typeof callResult === "string"
                    ? callResult
                    : ((callResultRecord?.data as string | undefined) ?? "0x");
            return decodeFunctionResult({
                abi: readAbi,
                functionName: fn.name,
                data: resultHex as Hex,
            });
        }
    }

    const data = encodeFunctionCallData(fn, args);
    const callResult = await rpcRequest(runner, "eth_call", [
        {to: address, data},
        "latest",
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
            "estimateContractGas" in provider &&
            typeof provider.estimateContractGas === "function"
        ) {
            return toBigIntValue(
                await provider.estimateContractGas(request),
                "estimateContractGas",
            );
        }
        if (
            "estimateGas" in provider &&
            typeof provider.estimateGas === "function"
        ) {
            const estimate = await provider.estimateGas(request);
            return toBigIntValue(estimate, "estimateGas");
        }
    }
    const estimated = await rpcRequest(runner, "eth_estimateGas", [
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
    return toBigIntValue(estimated, "eth_estimateGas");
}

async function withRunnerFrom(
    runner: RunnerLike,
    request: TxRequestLike,
): Promise<TxRequestLike> {
    if (request.from) return request;
    if (
        runner &&
        isObject(runner) &&
        "getAddress" in runner &&
        typeof runner.getAddress === "function"
    ) {
        try {
            const from = await (runner.getAddress as () => Promise<string>)();
            if (from) return {...request, from};
        } catch {
            // noop: fallback to request without explicit from
        }
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
            "waitForTransactionReceipt" in provider &&
            typeof provider.waitForTransactionReceipt === "function"
        ) {
            return toReceiptLike(
                await provider.waitForTransactionReceipt({
                    hash,
                    confirmations,
                }),
                hash,
            );
        }
        if (
            "waitForTransaction" in provider &&
            typeof provider.waitForTransaction === "function"
        ) {
            return toReceiptLike(
                await provider.waitForTransaction(hash, confirmations),
                hash,
            );
        }
    }

    const receipt = await rpcRequest(runner, "eth_getTransactionReceipt", [
        hash,
    ]);
    if (!receipt) {
        throw new Error(`Transaction receipt not found for ${hash}`);
    }
    return toReceiptLike(receipt, hash);
}

function asTxResponse(
    runner: RunnerLike,
    tx: unknown,
): SentTxLike {
    const txRecord = isObject(tx) ? tx : {};
    const maybeWait = txRecord.wait;
    const wait =
        typeof maybeWait === "function"
            ? (maybeWait as SentTxLike["wait"])
            : undefined;
    const hash =
        typeof tx === "string"
            ? tx
            : ((txRecord.hash as string | undefined) ??
              (txRecord.transactionHash as string | undefined));
    if (!hash || !wait) {
        throw new Error("Unable to extract transaction hash from send result");
    }
    return {
        ...txRecord,
        hash,
        wait: (confirmations?: number) =>
            wait(confirmations).catch(() =>
                waitForReceipt(runner, hash, confirmations),
            ),
    };
}

async function performSend(
    runner: RunnerLike,
    request: TxRequestLike,
): Promise<SentTxLike> {
    if (runner && isObject(runner)) {
        if (
            "sendTransaction" in runner &&
            typeof runner.sendTransaction === "function"
        ) {
            const sent = await runner.sendTransaction(request);
            return asTxResponse(runner, sent);
        }
        if (
            "writeContract" in runner &&
            typeof runner.writeContract === "function"
        ) {
            const hash = await runner.writeContract(request);
            return asTxResponse(runner, hash);
        }
    }

    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider)) {
        if (
            "sendTransaction" in provider &&
            typeof provider.sendTransaction === "function"
        ) {
            const sent = await provider.sendTransaction(request);
            return asTxResponse(runner, sent);
        }
    }

    const hash = await rpcRequest(runner, "eth_sendTransaction", [
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
    return asTxResponse(runner, hash);
}

async function performGetLogs(
    runner: RunnerLike,
    filter: Record<string, unknown>,
): Promise<Log[]> {
    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider)) {
        if ("getLogs" in provider && typeof provider.getLogs === "function") {
            return provider.getLogs(filter);
        }
    }
    const logs = await rpcRequest(runner, "eth_getLogs", [filter]);
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

    const callStatic = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return async (...rawArgs: unknown[]) => {
                    const fn = getFunctionAbi(abi, prop);
                    if (!fn) throw new Error(`Function ${prop} not found`);
                    const {fnArgs} = splitArgsAndOverrides(
                        rawArgs,
                        fn.inputs.length,
                    );
                    return performRead(
                        runner,
                        address,
                        fn,
                        normalizeFunctionArgs(fn, fnArgs),
                    );
                };
            },
        },
    ) as ContractCallStaticMap<TAbi>;

    const estimateGas = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return async (...rawArgs: unknown[]) => {
                    const fn = getFunctionAbi(abi, prop);
                    if (!fn) throw new Error(`Function ${prop} not found`);
                    const {fnArgs, overrides} = splitArgsAndOverrides(
                        rawArgs,
                        fn.inputs.length,
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

    const populateTransaction = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return async (...rawArgs: unknown[]) => {
                    const fn = getFunctionAbi(abi, prop);
                    if (!fn) throw new Error(`Function ${prop} not found`);
                    const {fnArgs, overrides} = splitArgsAndOverrides(
                        rawArgs,
                        fn.inputs.length,
                    );
                    const normalizedArgs = normalizeFunctionArgs(fn, fnArgs);
                    return {
                        to: address,
                        data: encodeFunctionCallData(fn, normalizedArgs),
                        ...overrides,
                    };
                };
            },
        },
    ) as ContractPopulateTransactionMap<TAbi>;

    const filters = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return (...args: unknown[]) => ({
                    address,
                    eventName: prop,
                    args,
                });
            },
        },
    ) as ContractFilterMap<TAbi>;

    const functions = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return (...args: unknown[]) => {
                    const method = contract[prop];
                    if (typeof method !== "function") {
                        throw new Error(`Function ${prop} not found`);
                    }
                    return method(...args);
                };
            },
            has(_target, prop) {
                if (typeof prop !== "string") return false;
                return !!getFunctionAbi(abi, prop);
            },
        },
    ) as ContractMethodMap<TAbi>;

    const contract = {
        address,
        signer: runner,
        provider: getRunnerProvider(runner),
        interface: iface,
        callStatic,
        estimateGas,
        populateTransaction,
        filters,
        functions,
        async queryFilter(
            filter: Record<string, unknown>,
            fromBlock?: unknown,
            toBlock?: unknown,
        ) {
            const filterAddress =
                (filter.address as string | undefined) ?? address;
            const eventName = filter.eventName as string | undefined;
            const eventArgs =
                (filter.args as readonly unknown[] | undefined) ?? [];

            const abiItem = eventName ? getEventAbi(abi, eventName) : undefined;

            const topics =
                abiItem && abiItem.type === "event"
                    ? encodeEventTopics({
                          abi: [abiItem],
                          eventName: abiItem.name,
                          args: eventArgs as readonly unknown[],
                      })
                    : (filter.topics as readonly Hex[] | undefined);

            const resolvedFromBlock = fromBlock ?? 0n;
            const logs = await performGetLogs(runner, {
                address: filterAddress,
                topics,
                fromBlock: toHexQuantity(resolvedFromBlock),
                toBlock: toHexQuantity(toBlock),
            });

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
                            blockNumber: normalizeLogBlock(
                                log as Record<string, unknown>,
                            ),
                        };
                    } catch {
                        return {
                            ...log,
                            blockNumber: normalizeLogBlock(
                                log as Record<string, unknown>,
                            ),
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

    return new Proxy(contract, {
        get(target, prop, receiver) {
            if (typeof prop !== "string")
                return Reflect.get(target, prop, receiver);
            if (prop in target) return Reflect.get(target, prop, receiver);

            const fn = getFunctionAbi(abi, prop);
            if (!fn) return Reflect.get(target, prop, receiver);

            return async (...rawArgs: unknown[]) => {
                const {fnArgs, overrides} = splitArgsAndOverrides(
                    rawArgs,
                    fn.inputs.length,
                );
                const normalizedArgs = normalizeFunctionArgs(fn, fnArgs);
                const stateMutability = fn.stateMutability ?? "nonpayable";
                if (stateMutability === "view" || stateMutability === "pure") {
                    return performRead(runner, address, fn, normalizedArgs);
                }

                const request: TxRequestLike = {
                    to: address,
                    data: encodeFunctionCallData(fn, normalizedArgs),
                    ...overrides,
                };
                const response = await performSend(runner, request);
                return normalizeWriteResult(response);
            };
        },
    }) as ViemContractLike<TAbi>;
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

    static createInterface<TAbi extends Abi>(
        this: {artifact: ArtifactEntry<TAbi>},
    ): ViemInterface<TAbi> {
        return createInterface(this.artifact.abi, this.artifact.bytecode);
    }

    static connect<TAbi extends Abi>(
        this: {artifact: ArtifactEntry<TAbi>},
        address: string,
        runner?: RunnerLike,
    ): ViemContractLike<TAbi> {
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
        return (this.constructor as unknown as {
            connect: (
                address: string,
                runner?: RunnerLike,
            ) => TContract;
        }).connect(
            address,
            this.runner,
        );
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
        const {fnArgs, overrides} = splitArgsAndOverrides(
            rawArgs,
            ctorInputs.length,
        );
        const deployTx = {
            ...this.getDeployTransaction(...fnArgs),
            ...overrides,
        };
        const txResponse = await performSend(this.runner, deployTx);
        const receipt = (await txResponse.wait()) as TransactionReceipt & {
            contractAddress?: string;
        };
        const contractAddress = receipt.contractAddress;
        if (!contractAddress) {
            throw new Error(
                `Deployment for ${
                    (this.constructor as typeof ViemContractFactory).artifact
                        .contractName
                } did not return contractAddress`,
            );
        }
        const contract = (
            this.constructor as unknown as {
                connect: (
                    address: string,
                    runner?: RunnerLike,
                ) => TContract;
            }
        ).connect(contractAddress, this.runner);
        const txHash =
            txResponse?.hash ??
            txResponse?.transactionHash ??
            "0x0000000000000000000000000000000000000000000000000000000000000000";
        contract.deployTransaction = {
            ...txResponse,
            hash: txHash,
            data: typeof deployTx.data === "string" ? deployTx.data : undefined,
            wait: txResponse.wait,
        };
        contract.deployed = async () => {
            await txResponse.wait();
            return contract;
        };
        return contract;
    }
}
