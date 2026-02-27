import {expect} from "chai";
import type {Abi} from "viem";
import {encodeFunctionData, encodeFunctionResult} from "viem";

import {createContractProxy} from "../core-utils/viemFactory.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000002";
const TEST_SENDER = "0x0000000000000000000000000000000000000001";
const TEST_BYTES32 = `0x${"11".repeat(32)}` as const;
const TEST_TX_HASH = `0x${"ab".repeat(32)}`;

const OVERLOADED_DISPATCH_ABI = [
    {
        type: "function",
        name: "dispatch",
        stateMutability: "payable",
        inputs: [
            {name: "destinationDomain", type: "uint32"},
            {name: "recipientAddress", type: "bytes32"},
            {name: "messageBody", type: "bytes"},
            {name: "metadata", type: "bytes"},
            {name: "hook", type: "address"},
        ],
        outputs: [{name: "", type: "bytes32"}],
    },
    {
        type: "function",
        name: "dispatch",
        stateMutability: "payable",
        inputs: [
            {name: "destinationDomain", type: "uint32"},
            {name: "recipientAddress", type: "bytes32"},
            {name: "messageBody", type: "bytes"},
            {name: "hookMetadata", type: "bytes"},
        ],
        outputs: [{name: "", type: "bytes32"}],
    },
    {
        type: "function",
        name: "dispatch",
        stateMutability: "payable",
        inputs: [
            {name: "destinationDomain", type: "uint32"},
            {name: "recipientAddress", type: "bytes32"},
            {name: "messageBody", type: "bytes"},
        ],
        outputs: [{name: "", type: "bytes32"}],
    },
] as const satisfies Abi;

const SET_VALUE_ABI = [
    {
        type: "function",
        name: "setValue",
        stateMutability: "nonpayable",
        inputs: [{name: "value", type: "uint256"}],
        outputs: [],
    },
] as const satisfies Abi;

const GET_VALUE_ABI = [
    {
        type: "function",
        name: "getValue",
        stateMutability: "view",
        inputs: [],
        outputs: [{name: "", type: "uint256"}],
    },
] as const satisfies Abi;

const GET_PAIR_ABI = [
    {
        type: "function",
        name: "getPair",
        stateMutability: "view",
        inputs: [],
        outputs: [
            {name: "left", type: "uint256"},
            {name: "right", type: "uint256"},
        ],
    },
] as const satisfies Abi;

const GET_IDS_ABI = [
    {
        type: "function",
        name: "getIds",
        stateMutability: "view",
        inputs: [],
        outputs: [{name: "", type: "uint256[]"}],
    },
] as const satisfies Abi;

describe("viemFactory", () => {
    it("resolves overloaded short-name calls using provided args", async () => {
        const sentPayloads: Record<string, unknown>[] = [];
        const runner = {
            request: async ({
                method,
                params,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_sendTransaction") {
                    sentPayloads.push(
                        (params?.[0] ?? {}) as Record<string, unknown>,
                    );
                    return TEST_TX_HASH;
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            OVERLOADED_DISPATCH_ABI,
            runner,
        );

        const dispatch = (
            contract as unknown as {
                dispatch(
                    ...args: readonly unknown[]
                ): Promise<{hash: string | undefined}>;
            }
        ).dispatch;
        const response = await dispatch(1, TEST_BYTES32, "0x1234");

        expect(response.hash, "expected write response hash").to.equal(
            TEST_TX_HASH,
        );
        expect(sentPayloads.length).to.equal(1);

        const expectedData = encodeFunctionData({
            abi: [OVERLOADED_DISPATCH_ABI[2]],
            functionName: "dispatch",
            args: [1n, TEST_BYTES32, "0x1234"],
        });
        expect(sentPayloads[0].data).to.equal(expectedData);
    });

    it("does not inject account for signer.sendTransaction by default", async () => {
        const seenRequests: Record<string, unknown>[] = [];
        const runner = {
            getAddress: async () => TEST_SENDER,
            sendTransaction: async (request: unknown) => {
                seenRequests.push(request as Record<string, unknown>);
                return {
                    hash: TEST_TX_HASH,
                    wait: async () => ({blockNumber: 1n, status: "0x1"}),
                };
            },
            provider: {
                send: async () => {
                    throw new Error("unexpected rpc fallback");
                },
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        );
        const setValue = (
            contract as unknown as {
                setValue(...args: readonly unknown[]): Promise<{hash: string}>;
            }
        ).setValue;
        const response = await setValue(7n);

        expect(response.hash, "expected write response hash").to.equal(
            TEST_TX_HASH,
        );
        expect(seenRequests.length).to.equal(1);
        expect("account" in seenRequests[0]).to.equal(false);
    });

    it("retries sendTransaction with account when runner requires it", async () => {
        const seenRequests: Record<string, unknown>[] = [];
        let attempts = 0;
        const runner = {
            getAddress: async () => TEST_SENDER,
            sendTransaction: async (request: unknown) => {
                attempts += 1;
                const tx = request as Record<string, unknown>;
                seenRequests.push(tx);
                if (attempts === 1) {
                    throw new Error("account is required");
                }
                if (tx.account !== TEST_SENDER) {
                    throw new Error("expected account to be injected on retry");
                }
                return {
                    hash: TEST_TX_HASH,
                    wait: async () => ({blockNumber: 1n, status: "0x1"}),
                };
            },
            provider: {
                send: async () => {
                    throw new Error("unexpected rpc fallback");
                },
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        );
        const setValue = (
            contract as unknown as {
                setValue(...args: readonly unknown[]): Promise<{hash: string}>;
            }
        ).setValue;
        const response = await setValue(9n);

        expect(response.hash, "expected write response hash").to.equal(
            TEST_TX_HASH,
        );
        expect(attempts).to.equal(2);
        expect("account" in seenRequests[0]).to.equal(false);
        expect(seenRequests[1].account).to.equal(TEST_SENDER);
    });

    it("does not treat trailing arrays as tx overrides", async () => {
        let sendTxCalls = 0;
        const runner = {
            request: async ({
                method,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_sendTransaction") {
                    sendTxCalls += 1;
                    return TEST_TX_HASH;
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        ) as unknown as {
            setValue: (...args: readonly unknown[]) => Promise<{hash: string}>;
        };

        let didThrow = false;
        try {
            await contract.setValue(7n, []);
        } catch {
            didThrow = true;
        }
        expect(didThrow).to.equal(true);
        expect(sendTxCalls).to.equal(0);
    });

    it("preserves unrecognized quantity objects instead of dropping them", async () => {
        const weirdValue = {foo: "bar"};
        const seenRequests: Record<string, unknown>[] = [];
        const runner = {
            getAddress: async () => TEST_SENDER,
            sendTransaction: async (request: unknown) => {
                seenRequests.push(request as Record<string, unknown>);
                return {
                    hash: TEST_TX_HASH,
                    wait: async () => ({blockNumber: 1n, status: "0x1"}),
                };
            },
            provider: {
                send: async () => {
                    throw new Error("unexpected rpc fallback");
                },
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        ) as unknown as {
            setValue: (...args: readonly unknown[]) => Promise<{hash: string}>;
        };

        await contract.setValue(7n, {value: weirdValue});
        expect(seenRequests.length).to.equal(1);
        expect(seenRequests[0].value).to.equal(weirdValue);
    });

    it("normalizes toString quantity wrappers for tx values", async () => {
        const quantityLike = {
            toString: () => "123",
        };
        const seenRequests: Record<string, unknown>[] = [];
        const runner = {
            getAddress: async () => TEST_SENDER,
            sendTransaction: async (request: unknown) => {
                seenRequests.push(request as Record<string, unknown>);
                return {
                    hash: TEST_TX_HASH,
                    wait: async () => ({blockNumber: 1n, status: "0x1"}),
                };
            },
            provider: {
                send: async () => {
                    throw new Error("unexpected rpc fallback");
                },
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        ) as unknown as {
            setValue: (...args: readonly unknown[]) => Promise<{hash: string}>;
        };

        await contract.setValue(7n, {value: quantityLike});
        expect(seenRequests.length).to.equal(1);
        expect(seenRequests[0].value).to.equal("0x7b");
    });

    it("preserves ethers-v5 wrapping for contract.functions reads", async () => {
        const runner = {
            request: async ({
                method,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_call") {
                    return encodeFunctionResult({
                        abi: [GET_VALUE_ABI[0]],
                        functionName: "getValue",
                        result: 42n,
                    });
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            GET_VALUE_ABI,
            runner,
        ) as unknown as {
            getValue: () => Promise<bigint>;
            functions: {
                getValue: () => Promise<readonly [bigint]>;
            };
        };

        const directRead = await contract.getValue();
        const wrappedRead = await contract.functions.getValue();

        expect(directRead).to.equal(42n);
        expect(wrappedRead).to.deep.equal([42n]);
    });

    it("does not double-wrap multi-value contract.functions reads", async () => {
        const runner = {
            request: async ({
                method,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_call") {
                    return encodeFunctionResult({
                        abi: [GET_PAIR_ABI[0]],
                        functionName: "getPair",
                        result: [1n, 2n],
                    });
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            GET_PAIR_ABI,
            runner,
        ) as unknown as {
            getPair: () => Promise<readonly [bigint, bigint]>;
            functions: {
                getPair: () => Promise<readonly [bigint, bigint]>;
            };
        };

        const directRead = await contract.getPair();
        const wrappedRead = await contract.functions.getPair();

        expect(directRead).to.deep.equal([1n, 2n]);
        expect(wrappedRead).to.deep.equal([1n, 2n]);
    });

    it("wraps single-array-output contract.functions reads like ethers-v5", async () => {
        const runner = {
            request: async ({
                method,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_call") {
                    return encodeFunctionResult({
                        abi: [GET_IDS_ABI[0]],
                        functionName: "getIds",
                        result: [1n, 2n],
                    });
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            GET_IDS_ABI,
            runner,
        ) as unknown as {
            getIds: () => Promise<readonly bigint[]>;
            functions: {
                getIds: () => Promise<readonly [readonly bigint[]]>;
            };
        };

        const directRead = await contract.getIds();
        const wrappedRead = await contract.functions.getIds();

        expect(directRead).to.deep.equal([1n, 2n]);
        expect(wrappedRead).to.deep.equal([[1n, 2n]]);
    });

    it("times out receipt polling fallback when no receipt appears", async () => {
        const runner = {
            receiptTimeoutMs: 1,
            request: async ({
                method,
            }: {
                method: string;
                params?: readonly unknown[];
            }) => {
                if (method === "eth_sendTransaction") {
                    return TEST_TX_HASH;
                }
                if (method === "eth_getTransactionReceipt") {
                    return null;
                }
                throw new Error(`Unexpected rpc method ${method}`);
            },
        };

        const contract = createContractProxy(
            TEST_CONTRACT_ADDRESS,
            SET_VALUE_ABI,
            runner,
        ) as unknown as {
            setValue: (...args: readonly unknown[]) => Promise<{
                hash: string;
                wait: (confirmations?: number) => Promise<unknown>;
            }>;
        };

        const response = await contract.setValue(1n);

        let didTimeout = false;
        try {
            await response.wait(1);
        } catch (error) {
            didTimeout = true;
            expect(String(error)).to.contain("Timeout (1ms)");
            expect(String(error)).to.contain(TEST_TX_HASH);
        }

        expect(
            didTimeout,
            "expected receipt polling fallback to timeout",
        ).to.eq(true);
    });
});
