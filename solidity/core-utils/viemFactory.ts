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
    AbiEvent,
    AbiFunction,
    AbiParameter,
    Hex,
    Log,
    TransactionReceipt,
} from "viem";

export interface ArtifactEntry {
    readonly contractName: string;
    readonly abi: Abi;
    readonly bytecode: Hex;
}

type JsonRpcLike = {
    request: (args: {
        method: string;
        params?: readonly unknown[];
    }) => Promise<any>;
};

type SendLike = {
    send: (method: string, params?: readonly unknown[]) => Promise<any>;
};

type RunnerLike = any;

type TxRequestLike = Record<string, any>;

export interface ViemContractLike {
    address: string;
    interface: any;
    populateTransaction: any;
    callStatic: any;
    estimateGas: any;
    filters: any;
    functions: any;
    queryFilter: <T = any>(
        filter: Record<string, unknown>,
        fromBlock?: unknown,
        toBlock?: unknown,
    ) => Promise<T[]>;
    connect: (runner: RunnerLike) => ViemContractLike;
    attach: (address: string) => ViemContractLike;
    signer: RunnerLike;
    provider: RunnerLike;
    deployTransaction?: {
        hash: string;
        data?: string;
        wait: (confirmations?: number) => Promise<any>;
    };
    deployed?: () => Promise<ViemContractLike>;
    [key: string]: any;
}

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
): Promise<any> {
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
            encode: (args = []) =>
                encodeFunctionData({
                    abi: [fn] as Abi,
                    functionName: fn.name,
                    args: [...normalizeFunctionArgs(fn, args)] as any[],
                }),
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

export function createInterface(abi: Abi, bytecode?: Hex): any {
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
            return encodeFunctionData({
                abi: [fn] as Abi,
                functionName: fn.name,
                args: [...normalizeFunctionArgs(fn, args)] as any[],
            });
        },
        decodeFunctionResult(functionName: string, data: Hex) {
            const fn = getFunctionAbi(abi, functionName);
            if (!fn) {
                throw new Error(`Function ${functionName} not found`);
            }
            return decodeFunctionResult({
                abi: [fn] as Abi,
                functionName: fn.name,
                data,
            });
        },
        encodeDeploy(args: readonly unknown[] = []) {
            if (!bytecode || bytecode === "0x")
                return bytecode ?? ("0x" as Hex);
            const inputs = getConstructorInputs(abi);
            if (!inputs.length) return bytecode;
            const encodedArgs = encodeAbiParameters(
                inputs as any[],
                [...args] as any[],
            );
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
            const event = getAbiItem({
                abi,
                name: eventNameOrSignature,
            });
            if (!event || event.type !== "event") {
                throw new Error(`Event ${eventNameOrSignature} not found`);
            }
            return toEventSelector(getEventSignature(event));
        },
    };
}

async function performRead(
    runner: RunnerLike,
    address: string,
    fn: AbiFunction,
    args: readonly unknown[],
): Promise<any> {
    const readAbi = [fn] as Abi;
    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider)) {
        if (
            "readContract" in provider &&
            typeof provider.readContract === "function"
        ) {
            return (provider.readContract as any)({
                address,
                abi: readAbi,
                functionName: fn.name,
                args: [...args],
            });
        }
        if ("call" in provider && typeof provider.call === "function") {
            const data = encodeFunctionData({
                abi: readAbi,
                functionName: fn.name,
                args: [...args] as any[],
            });
            const callResult = await (provider.call as any)({
                to: address,
                data,
            });
            const resultHex =
                typeof callResult === "string"
                    ? callResult
                    : ((callResult?.data as string | undefined) ?? "0x");
            return decodeFunctionResult({
                abi: readAbi,
                functionName: fn.name,
                data: resultHex as Hex,
            });
        }
    }

    const data = encodeFunctionData({
        abi: readAbi,
        functionName: fn.name,
        args: [...args] as any[],
    });
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
            return BigInt(await (provider.estimateContractGas as any)(request));
        }
        if (
            "estimateGas" in provider &&
            typeof provider.estimateGas === "function"
        ) {
            const estimate = await (provider.estimateGas as any)(request);
            return typeof estimate === "bigint" ? estimate : BigInt(estimate);
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
    return BigInt(estimated);
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
            return (provider.waitForTransactionReceipt as any)({
                hash,
                confirmations,
            });
        }
        if (
            "waitForTransaction" in provider &&
            typeof provider.waitForTransaction === "function"
        ) {
            return (provider.waitForTransaction as any)(hash, confirmations);
        }
    }

    const receipt = await rpcRequest(runner, "eth_getTransactionReceipt", [
        hash,
    ]);
    if (!receipt) {
        throw new Error(`Transaction receipt not found for ${hash}`);
    }
    return receipt;
}

function asTxResponse(runner: RunnerLike, tx: any) {
    if (tx && typeof tx.wait === "function") return tx;
    const hash =
        typeof tx === "string"
            ? tx
            : ((tx?.hash as string | undefined) ??
              (tx?.transactionHash as string | undefined));
    if (!hash) return tx;
    return {
        ...tx,
        hash,
        wait: (confirmations?: number) =>
            waitForReceipt(runner, hash, confirmations),
    };
}

async function performSend(
    runner: RunnerLike,
    request: TxRequestLike,
): Promise<any> {
    if (runner && isObject(runner)) {
        if (
            "sendTransaction" in runner &&
            typeof runner.sendTransaction === "function"
        ) {
            const sent = await (runner.sendTransaction as any)(request);
            return asTxResponse(runner, sent);
        }
        if (
            "writeContract" in runner &&
            typeof runner.writeContract === "function"
        ) {
            const hash = await (runner.writeContract as any)(request);
            return asTxResponse(runner, hash);
        }
    }

    const provider = getRunnerProvider(runner);
    if (provider && isObject(provider)) {
        if (
            "sendTransaction" in provider &&
            typeof provider.sendTransaction === "function"
        ) {
            const sent = await (provider.sendTransaction as any)(request);
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
            return (provider.getLogs as any)(filter);
        }
    }
    const logs = await rpcRequest(runner, "eth_getLogs", [filter]);
    return logs as Log[];
}

function normalizeWriteResult(result: unknown): unknown {
    if (Array.isArray(result) && result.length === 1) return result[0];
    return result;
}

export function createContractProxy(
    address: string,
    abi: Abi,
    runner: RunnerLike,
): any {
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
    ) as Record<string, (...args: any[]) => Promise<any>>;

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
                    const request = {
                        to: address,
                        data: encodeFunctionData({
                            abi,
                            functionName: fn.name,
                            args: normalizedArgs as any[],
                        }),
                        ...overrides,
                    };
                    return performEstimateGas(runner, request);
                };
            },
        },
    ) as Record<string, (...args: any[]) => Promise<bigint>>;

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
                        data: encodeFunctionData({
                            abi,
                            functionName: fn.name,
                            args: normalizedArgs as any[],
                        }),
                        ...overrides,
                    };
                };
            },
        },
    ) as Record<string, (...args: any[]) => Promise<TxRequestLike>>;

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
    ) as Record<string, (...args: any[]) => Record<string, unknown>>;

    const functions = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                return (...args: unknown[]) =>
                    (contract as any)[prop](...(args as any[]));
            },
            has(_target, prop) {
                if (typeof prop !== "string") return false;
                return !!getFunctionAbi(abi, prop);
            },
        },
    ) as Record<string, (...args: any[]) => Promise<any>>;

    const contract: any = {
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

            const abiItem = eventName
                ? (getAbiItem({
                      abi,
                      name: eventName,
                  }) as AbiEvent | undefined)
                : undefined;

            const topics =
                abiItem && abiItem.type === "event"
                    ? encodeEventTopics({
                          abi: [abiItem],
                          eventName: abiItem.name,
                          args: eventArgs as any[],
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
    } as ViemContractLike;

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
                    data: encodeFunctionData({
                        abi,
                        functionName: fn.name,
                        args: normalizedArgs as any[],
                    }),
                    ...overrides,
                };
                const response = await performSend(runner, request);
                return normalizeWriteResult(response);
            };
        },
    }) as ViemContractLike;
}

export class ViemContractFactory {
    static artifact: ArtifactEntry;

    static get abi(): Abi {
        return this.artifact.abi;
    }

    static get bytecode(): Hex {
        return this.artifact.bytecode;
    }

    static createInterface() {
        return createInterface(this.abi, this.bytecode);
    }

    static connect(address: string, runner?: RunnerLike): any {
        return createContractProxy(address, this.abi, runner);
    }

    runner?: RunnerLike;

    constructor(runner?: RunnerLike) {
        this.runner = runner;
    }

    connect(runner: RunnerLike): this {
        this.runner = runner;
        return this;
    }

    attach(address: string): any {
        return (this.constructor as typeof ViemContractFactory).connect(
            address,
            this.runner,
        );
    }

    getDeployTransaction(...constructorArgs: readonly unknown[]): any {
        const iface = (
            this.constructor as typeof ViemContractFactory
        ).createInterface();
        return {
            data: iface.encodeDeploy(constructorArgs),
        } as TxRequestLike;
    }

    async deploy(...rawArgs: readonly unknown[]): Promise<any> {
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
            this.constructor as typeof ViemContractFactory
        ).connect(contractAddress, this.runner);
        const txHash =
            txResponse?.hash ??
            txResponse?.transactionHash ??
            "0x0000000000000000000000000000000000000000000000000000000000000000";
        contract.deployTransaction = {
            ...txResponse,
            hash: txHash,
            data: deployTx.data,
            wait: txResponse.wait,
        };
        contract.deployed = async () => {
            await txResponse.wait();
            return contract;
        };
        return contract;
    }
}
