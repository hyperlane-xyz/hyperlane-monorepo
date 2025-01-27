import { Address, Cell, Dictionary } from '@ton/core';
import { Signature } from 'ethers';

export type THookMetadata = {
    variant: number;
    msgValue: bigint;
    gasLimit: bigint;
    refundAddress: Address;
};

export type TGasConfig = {
    gasOracle: bigint;
    gasOverhead: bigint;
    exchangeRate: bigint;
    gasPrice: bigint;
};

export type TSignature = {
    s: bigint;
    v: bigint;
    r: bigint;
};

export type TMultisigMetadata = {
    originMerkleHook: Buffer;
    root: Buffer;
    index: bigint;
    signatures: TSignature[];
};

export type TMessage = {
    version: number;
    nonce: number;
    origin: number;
    sender: Buffer;
    destinationDomain: number;
    recipient: Buffer;
    body: Cell;
};

export type TDelivery = {
    processorAddr: Address;
    blockNumber: bigint;
};

export type TMailboxContractConfig = {
    version: number;
    localDomain: number;
    nonce: number;
    latestDispatchedId: bigint;
    defaultIsm: Address;
    defaultHookAddr: Address;
    requiredHookAddr: Address;
    owner: Address;
    deliveries: Dictionary<bigint, TDelivery>;
};
