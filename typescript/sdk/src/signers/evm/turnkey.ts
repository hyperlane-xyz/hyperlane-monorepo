import {
    Hex,
    hashMessage,
    serializeSignature,
    serializeTransaction,
    toBytes,
} from "viem";

import {rootLogger} from "@hyperlane-xyz/utils";

import {
    TurnkeyClientManager,
    TurnkeyConfig,
    logTurnkeyError,
    validateTurnkeyActivityCompleted,
} from "../turnkeyClient.js";

const logger = rootLogger.child({module: "sdk:turnkey-evm"});

type EvmProviderLike = {
    estimateGas(transaction: TurnkeyTransactionRequest): Promise<unknown>;
    getFeeData(): Promise<{
        gasPrice?: unknown;
        maxFeePerGas?: unknown;
        maxPriorityFeePerGas?: unknown;
    }>;
    getNetwork(): Promise<{chainId: number}>;
    getTransactionCount(address: string, blockTag?: string): Promise<number>;
};

type TurnkeyTransactionRequest = {
    chainId?: number;
    data?: Hex;
    from?: string;
    gasLimit?: unknown;
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
    nonce?: number;
    to?: string;
    type?: number;
    value?: unknown;
};

const toBigIntValue = (value: unknown): bigint | undefined =>
    value === null || value === undefined
        ? undefined
        : BigInt(value.toString());

/**
 * Turnkey signer for EVM transactions
 * Uses Turnkey's secure enclaves to sign transactions without exposing private keys
 * This is a custom EVM signer that uses Turnkey SDK directly.
 * Uses composition to access Turnkey functionality.
 *
 * @example
 * ```typescript
 * const config: TurnkeyConfig = {
 *   organizationId: 'your-org-id',
 *   apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
 *   apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
 *   privateKeyId: 'your-private-key-id',
 *   publicKey: '0x...', // Ethereum address
 * };
 *
 * const provider = multiProvider.getProvider('ethereum');
 * const signer = new TurnkeyEvmSigner(config, provider);
 *
 * // Use with MultiProvider
 * multiProvider.setSigner('ethereum', signer);
 * ```
 */
export class TurnkeyEvmSigner {
    private readonly manager: TurnkeyClientManager;
    public readonly address: string;
    public readonly provider: EvmProviderLike | undefined;

    constructor(config: TurnkeyConfig, provider?: EvmProviderLike) {
        this.manager = new TurnkeyClientManager(config);
        this.address = config.publicKey;
        this.provider = provider;

        logger.debug(`Initialized Turnkey EVM signer for key: ${this.address}`);
    }

    /**
     * Health check - delegates to manager
     */
    async healthCheck(): Promise<boolean> {
        return this.manager.healthCheck();
    }

    /**
     * Get an ethers Signer connected to the provided provider
     * This returns a new instance with the provider connected
     */
    async getSigner(provider: EvmProviderLike): Promise<TurnkeyEvmSigner> {
        logger.debug("Creating Turnkey EVM signer for transaction");
        return this.connect(provider);
    }

    /**
     * Connect this signer to a provider (creates new instance with proper configuration)
     */
    connect(provider: EvmProviderLike): TurnkeyEvmSigner {
        return new TurnkeyEvmSigner(this.manager.getConfig(), provider);
    }

    /**
     * Get the address of this signer
     */
    async getAddress(): Promise<string> {
        return this.address;
    }

    /**
     * Sign a transaction using Turnkey
     */
    async signTransaction(
        transaction: TurnkeyTransactionRequest,
    ): Promise<string> {
        if (!this.provider) {
            throw new Error("Provider required to sign transaction");
        }

        logger.debug("Signing transaction with Turnkey", {
            to: transaction.to,
            value: transaction.value?.toString(),
        });

        try {
            // Populate the transaction (fill in nonce, gasPrice, etc.)
            const populatedTx = await this.populateTransaction(transaction);

            // Remove 'from' field for serialization
            const {from: _, ...txToSerialize} = populatedTx;

            // For EIP-1559 transactions, explicitly set type: 2 and remove gasPrice
            if (
                txToSerialize.maxFeePerGas ||
                txToSerialize.maxPriorityFeePerGas
            ) {
                txToSerialize.type = 2;
                delete txToSerialize.gasPrice;
            }

            const unsignedTx = serializeTransaction(txToSerialize as any);

            // Remove 0x prefix for Turnkey API (it expects raw hex)
            const unsignedTxHex = unsignedTx.startsWith("0x")
                ? unsignedTx.slice(2)
                : unsignedTx;

            // Sign using Turnkey's signTransaction API
            const {activity} = await this.manager.getClient().signTransaction({
                signWith: this.address,
                type: "TRANSACTION_TYPE_ETHEREUM",
                unsignedTransaction: unsignedTxHex,
            });

            validateTurnkeyActivityCompleted(activity, "Transaction signing");

            const signedTx =
                activity.result?.signTransactionResult?.signedTransaction;
            if (!signedTx) {
                throw new Error("No signed transaction returned from Turnkey");
            }

            logger.debug("Transaction signed successfully");
            // Ensure the signed transaction has 0x prefix
            return signedTx.startsWith("0x") ? signedTx : `0x${signedTx}`;
        } catch (error) {
            logTurnkeyError("Failed to sign transaction with Turnkey", error);
            throw error;
        }
    }

    /**
     * Sign a message using Turnkey
     */
    async signMessage(message: string | Uint8Array): Promise<string> {
        logger.debug("Signing message with Turnkey");

        try {
            const messageBytes =
                typeof message === "string" ? toBytes(message) : message;
            const messageHash = hashMessage(messageBytes);

            // Sign raw payload using Turnkey
            const {activity, r, s, v} = await this.manager
                .getClient()
                .signRawPayload({
                    signWith: this.address,
                    payload: messageHash.slice(2), // Remove 0x prefix
                    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
                    hashFunction: "HASH_FUNCTION_NO_OP",
                });

            validateTurnkeyActivityCompleted(activity, "Message signing");

            // Validate signature components
            if (!r || !s || !v) {
                throw new Error("Missing signature components from Turnkey");
            }

            const hexPattern = /^0x[0-9a-fA-F]+$/;
            if (!hexPattern.test(r) || !hexPattern.test(s)) {
                throw new Error("Invalid signature format from Turnkey");
            }

            const vNum = parseInt(v, 16);
            if (isNaN(vNum)) {
                throw new Error(`Invalid v value from Turnkey: ${v}`);
            }

            // Reconstruct the signature from r, s, v
            return serializeSignature({
                r: r as Hex,
                s: s as Hex,
                v: BigInt(vNum),
            });
        } catch (error) {
            logTurnkeyError("Failed to sign message with Turnkey", error);
            throw error;
        }
    }

    /**
     * Populate a transaction with default values (nonce, gas, etc.)
     */
    async populateTransaction(
        transaction: TurnkeyTransactionRequest,
    ): Promise<TurnkeyTransactionRequest> {
        if (!this.provider) {
            throw new Error("Provider required to populate transaction");
        }

        const tx = {...transaction};

        // Set from address
        if (!tx.from) {
            tx.from = this.address;
        }

        // Get nonce if not set
        if (tx.nonce == null) {
            tx.nonce = await this.provider.getTransactionCount(
                this.address,
                "pending",
            );
        }

        // Get gas price if not set
        if (tx.gasPrice == null && tx.maxFeePerGas == null) {
            const feeData = await this.provider.getFeeData();
            if (feeData.maxFeePerGas) {
                tx.maxFeePerGas = toBigIntValue(feeData.maxFeePerGas);
                tx.maxPriorityFeePerGas =
                    toBigIntValue(feeData.maxPriorityFeePerGas) || undefined;
            } else {
                tx.gasPrice = toBigIntValue(feeData.gasPrice) || undefined;
            }
        }

        // Get chain ID if not set
        if (tx.chainId == null) {
            const network = await this.provider.getNetwork();
            tx.chainId = network.chainId;
        }

        // Estimate gas if not set
        if (tx.gasLimit == null) {
            tx.gasLimit = toBigIntValue(await this.provider.estimateGas(tx));
        }

        return tx;
    }
}
