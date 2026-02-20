import {password} from "@inquirer/prompts";
import {randomBytes} from "crypto";
import {type Hex, hexToBytes, pad, serializeSignature, toHex} from "viem";
import {Wallet} from "zksync-ethers";

import {
    ECDSAStakeRegistry__factory,
    TestAVSDirectory__factory,
} from "@hyperlane-xyz/core";
import {type ChainName} from "@hyperlane-xyz/sdk";
import {type Address} from "@hyperlane-xyz/utils";

import {type WriteCommandContext} from "../context/types.js";
import {log, logBlue} from "../logger.js";
import {readFileAtPath, resolvePath} from "../utils/files.js";

import {avsAddresses} from "./config.js";

export type SignatureWithSaltAndExpiryStruct = {
    signature: Hex;
    salt: Hex;
    expiry: Hex;
};

export async function registerOperatorWithSignature({
    context,
    chain,
    operatorKeyPath,
    avsSigningKeyAddress,
}: {
    context: WriteCommandContext;
    chain: ChainName;
    operatorKeyPath: string;
    avsSigningKeyAddress: Address;
}) {
    const {multiProvider} = context;

    const operatorAsSigner =
        await readOperatorFromEncryptedJson(operatorKeyPath);

    const provider = multiProvider.getProvider(chain);
    const connectedSigner = operatorAsSigner.connect(provider);

    const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

    const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
        stakeRegistryAddress,
        connectedSigner,
    );

    const domainId = multiProvider.getDomainId(chain);
    const avsDirectoryAddress = avsAddresses[chain].avsDirectory;
    const operatorSignature = await getOperatorSignature(
        domainId,
        avsAddresses[chain].hyperlaneServiceManager,
        avsDirectoryAddress,
        operatorAsSigner,
        connectedSigner,
    );

    // check if the operator is already registered
    const operatorStatus = await ecdsaStakeRegistry.operatorRegistered(
        operatorAsSigner.address,
    );
    if (operatorStatus) {
        logBlue(
            `Operator ${operatorAsSigner.address} already registered to Hyperlane AVS`,
        );
        return;
    }

    log(
        `Registering operator ${operatorAsSigner.address} attesting ${avsSigningKeyAddress} with signature on ${chain}...`,
    );
    await multiProvider.handleTx(
        chain,
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operatorSignature,
            avsSigningKeyAddress,
        ),
    );
    logBlue(`Operator ${operatorAsSigner.address} registered to Hyperlane AVS`);
}

export async function deregisterOperator({
    context,
    chain,
    operatorKeyPath,
}: {
    context: WriteCommandContext;
    chain: ChainName;
    operatorKeyPath: string;
}) {
    const {multiProvider} = context;

    const operatorAsSigner =
        await readOperatorFromEncryptedJson(operatorKeyPath);

    const provider = multiProvider.getProvider(chain);
    const connectedSigner = operatorAsSigner.connect(provider);

    const stakeRegistryAddress = avsAddresses[chain].ecdsaStakeRegistry;

    const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
        stakeRegistryAddress,
        connectedSigner,
    );

    log(`Deregistering operator ${operatorAsSigner.address} on ${chain}...`);
    await multiProvider.handleTx(
        chain,
        ecdsaStakeRegistry.deregisterOperator(),
    );
    logBlue(
        `Operator ${operatorAsSigner.address} deregistered from Hyperlane AVS`,
    );
}

export async function readOperatorFromEncryptedJson(
    operatorKeyPath: string,
): Promise<Wallet> {
    const encryptedJson = readFileAtPath(resolvePath(operatorKeyPath));

    const keyFilePassword = await password({
        mask: "*",
        message: "Enter the password for the operator key file: ",
    });

    return Wallet.fromEncryptedJson(encryptedJson, keyFilePassword);
}

async function getOperatorSignature(
    domain: number,
    serviceManager: Address,
    avsDirectory: Address,
    operator: Wallet,
    signer: Wallet,
): Promise<SignatureWithSaltAndExpiryStruct> {
    const avsDirectoryContract = TestAVSDirectory__factory.connect(
        avsDirectory,
        signer,
    );

    // random salt is ok, because we register the operator right after
    const salt = toHex(randomBytes(32));
    // give an expiry timestamp 1 hour from now
    const expiry = pad(toHex(Math.floor(Date.now() / 1000) + 60 * 60), {
        size: 32,
    });

    const signingHash =
        await avsDirectoryContract.calculateOperatorAVSRegistrationDigestHash(
            operator.address,
            serviceManager,
            salt,
            expiry,
        );

    // Eigenlayer's AVSDirectory expects the signature over raw signed hash instead of EIP-191 compatible toEthSignedMessageHash
    // see https://github.com/Layr-Labs/eigenlayer-contracts/blob/ef2ea4a7459884f381057aa9bbcd29c7148cfb63/src/contracts/libraries/EIP1271SignatureUtils.sol#L22
    const signature = operator
        ._signingKey()
        .signDigest(hexToBytes(signingHash));

    return {
        signature: serializeSignature({
            r: signature.r as Hex,
            s: signature.s as Hex,
            v: BigInt(signature.v),
        }),
        salt,
        expiry,
    };
}
