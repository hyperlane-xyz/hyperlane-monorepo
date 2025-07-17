import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId, PrivateKey, PublicKey, TransactionHash, TransactionManifest } from '@radixdlt/radix-engine-toolkit';
type Account = {
    privateKey: PrivateKey;
    publicKey: PublicKey;
    address: string;
};
export { NetworkId };
export interface RadixSDKOptions {
    networkId?: number;
}
export interface RadixSDKSigningOptions extends RadixSDKOptions {
    gasAmount?: number;
}
export declare class RadixSDK {
    protected networkId: number;
    protected gateway: GatewayApiClient;
    constructor(options?: RadixSDKOptions);
    getXrdAddress(): Promise<string>;
    getBalance(address: string, resource: string): Promise<string>;
    getXrdBalance(address: string): Promise<string>;
    queryMailbox(mailbox: string): Promise<{
        address: string;
        owner: string;
        localDomain: number;
        nonce: number;
        defaultIsm: string;
        defaultHook: string;
        requiredHook: string;
    }>;
    queryIsm(ism: string): Promise<{
        address: string;
        type: 'MerkleRootMultisigIsm' | 'MessageIdMultisigIsm' | 'NoopIsm';
        validators: string[];
        threshold: number;
    }>;
    queryIgpHook(hook: string): Promise<{
        address: string;
        owner: string;
        destinationGasConfigs: {
            [domainId: string]: {
                gasOracle: {
                    tokenExchangeRate: string;
                    gasPrice: string;
                };
                gasOverhead: string;
            };
        };
    }>;
    queryMerkleTreeHook(hook: string): Promise<{
        address: string;
    }>;
    queryToken(token: string): Promise<{
        address: string;
        tokenType: 'COLLATERAL' | 'SYNTHETIC';
        mailbox: string;
        ism: string;
    }>;
    queryEnrolledRouters(token: string, domainId: string | number): Promise<{
        address: string;
    }>;
}
export declare class RadixSigningSDK extends RadixSDK {
    private gasAmount;
    private account;
    constructor(account: Account, options?: RadixSDKSigningOptions);
    private static generateNewEd25519VirtualAccount;
    static fromRandomPrivateKey(options?: RadixSDKOptions): Promise<RadixSigningSDK>;
    static fromPrivateKey(privateKey: string, options?: RadixSDKOptions): Promise<RadixSigningSDK>;
    getAddress(): string;
    getTestnetXrd(): Promise<string>;
    private getNewComponent;
    private static generateSecureRandomBytes;
    private signIntent;
    private notarizeIntent;
    private createCallFunctionManifest;
    private createCallMethodManifest;
    private createCallMethodManifestWithOwner;
    signAndBroadcast(manifest: TransactionManifest): Promise<TransactionHash>;
    private pollForCommit;
    populateTransfer(toAddress: string, resourceAddress: string, amount: string): TransactionManifest;
    transfer(toAddress: string, resourceAddress: string, amount: string): Promise<string>;
    populateCreateMailbox(domainId: number): TransactionManifest;
    createMailbox(domainId: number): Promise<string>;
    populateSetIgpOwner(igp: string, newOwner: string): Promise<TransactionManifest>;
    setIgpOwner(igp: string, newOwner: string): Promise<string>;
    populateCreateMerkleTreeHook(mailbox: string): TransactionManifest;
    createMerkleTreeHook(mailbox: string): Promise<string>;
    populateCreateMerkleRootMultisigIsm(validators: string[], threshold: number): TransactionManifest;
    createMerkleRootMultisigIsm(validators: string[], threshold: number): Promise<string>;
    populateCreateMessageIdMultisigIsm(validators: string[], threshold: number): TransactionManifest;
    createMessageIdMultisigIsm(validators: string[], threshold: number): Promise<string>;
    populateCreateNoopIsm(): TransactionManifest;
    createNoopIsm(): Promise<string>;
    populateCreateIgp(denom: string): TransactionManifest;
    createIgp(denom: string): Promise<string>;
    populateSetMailboxOwner(mailbox: string, newOwner: string): Promise<TransactionManifest>;
    setMailboxOwner(mailbox: string, newOwner: string): Promise<string>;
    populateCreateValidatorAnnounce(mailbox: string): TransactionManifest;
    createValidatorAnnounce(mailbox: string): Promise<string>;
    populateSetRequiredHook(mailbox: string, hook: string): TransactionManifest;
    setRequiredHook(mailbox: string, hook: string): Promise<void>;
    populateSetDefaultHook(mailbox: string, hook: string): TransactionManifest;
    setDefaultHook(mailbox: string, hook: string): Promise<void>;
    populateSetDefaultIsm(mailbox: string, ism: string): TransactionManifest;
    setDefaultIsm(mailbox: string, ism: string): Promise<void>;
    populateCreateCollateralToken(mailbox: string, originDenom: string): TransactionManifest;
    createCollateralToken(mailbox: string, originDenom: string): Promise<string>;
    populateCreateSyntheticToken(mailbox: string, name: string, symbol: string, description: string, divisibility: number): TransactionManifest;
    createSyntheticToken(mailbox: string, name: string, symbol: string, description: string, divisibility: number): Promise<string>;
    populateSetTokenIsm(token: string, ism: string): Promise<TransactionManifest>;
    setTokenIsm(token: string, ism: string): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map