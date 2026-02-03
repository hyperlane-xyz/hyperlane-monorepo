import { Types } from 'tronweb';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { TronSDKReceipt, TronSDKTransaction } from '../utils/types.js';
import { TronProvider } from './provider.js';
/**
 * TronSigner extends TronProvider with transaction signing capabilities.
 * It can deploy contracts and execute contract methods.
 */
export declare class TronSigner extends TronProvider implements AltVM.ISigner<TronSDKTransaction, TronSDKReceipt> {
    private signerAddress;
    private constructor();
    static connectWithSigner(rpcUrls: string[], privateKey: string, extraParams?: Record<string, unknown>): Promise<TronSigner>;
    getSignerAddress(): string;
    supportsTransactionBatching(): boolean;
    transactionToPrintableJson(transaction: TronSDKTransaction): Promise<object>;
    sendAndConfirmTransaction(transaction: TronSDKTransaction): Promise<TronSDKReceipt>;
    sendAndConfirmBatchTransactions(_transactions: TronSDKTransaction[]): Promise<TronSDKReceipt>;
    private waitForConfirmation;
    private deployContract;
    private callContractMethod;
    createMailbox(_req: Omit<AltVM.ReqCreateMailbox, 'signer'>): Promise<AltVM.ResCreateMailbox>;
    setDefaultIsm(req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>): Promise<AltVM.ResSetDefaultIsm>;
    setDefaultHook(req: Omit<AltVM.ReqSetDefaultHook, 'signer'>): Promise<AltVM.ResSetDefaultHook>;
    setRequiredHook(req: Omit<AltVM.ReqSetRequiredHook, 'signer'>): Promise<AltVM.ResSetRequiredHook>;
    setMailboxOwner(req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>): Promise<AltVM.ResSetMailboxOwner>;
    createMerkleRootMultisigIsm(_req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>): Promise<AltVM.ResCreateMerkleRootMultisigIsm>;
    createMessageIdMultisigIsm(_req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>): Promise<AltVM.ResCreateMessageIdMultisigIsm>;
    createRoutingIsm(_req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>): Promise<AltVM.ResCreateRoutingIsm>;
    setRoutingIsmRoute(req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>): Promise<AltVM.ResSetRoutingIsmRoute>;
    removeRoutingIsmRoute(req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>): Promise<AltVM.ResRemoveRoutingIsmRoute>;
    setRoutingIsmOwner(req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>): Promise<AltVM.ResSetRoutingIsmOwner>;
    createNoopIsm(_req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>): Promise<AltVM.ResCreateNoopIsm>;
    createMerkleTreeHook(_req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>): Promise<AltVM.ResCreateMerkleTreeHook>;
    createInterchainGasPaymasterHook(_req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>): Promise<AltVM.ResCreateInterchainGasPaymasterHook>;
    setInterchainGasPaymasterHookOwner(req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner>;
    setDestinationGasConfig(req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>): Promise<AltVM.ResSetDestinationGasConfig>;
    removeDestinationGasConfig(_req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>): Promise<AltVM.ResRemoveDestinationGasConfig>;
    createNoopHook(_req: Omit<AltVM.ReqCreateNoopHook, 'signer'>): Promise<AltVM.ResCreateNoopHook>;
    createValidatorAnnounce(_req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>): Promise<AltVM.ResCreateValidatorAnnounce>;
    createNativeToken(_req: Omit<AltVM.ReqCreateNativeToken, 'signer'>): Promise<AltVM.ResCreateNativeToken>;
    createCollateralToken(_req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>): Promise<AltVM.ResCreateCollateralToken>;
    createSyntheticToken(_req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>): Promise<AltVM.ResCreateSyntheticToken>;
    setTokenOwner(req: Omit<AltVM.ReqSetTokenOwner, 'signer'>): Promise<AltVM.ResSetTokenOwner>;
    setTokenIsm(req: Omit<AltVM.ReqSetTokenIsm, 'signer'>): Promise<AltVM.ResSetTokenIsm>;
    setTokenHook(req: Omit<AltVM.ReqSetTokenHook, 'signer'>): Promise<AltVM.ResSetTokenHook>;
    enrollRemoteRouter(req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>): Promise<AltVM.ResEnrollRemoteRouter>;
    unenrollRemoteRouter(req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>): Promise<AltVM.ResUnenrollRemoteRouter>;
    transfer(req: Omit<AltVM.ReqTransfer, 'signer'>): Promise<AltVM.ResTransfer>;
    remoteTransfer(req: Omit<AltVM.ReqRemoteTransfer, 'signer'>): Promise<AltVM.ResRemoteTransfer>;
    /**
     * Deploy a contract with ABI and bytecode.
     * This is the low-level method used by higher-level deployment functions.
     */
    deployContractWithArtifacts(params: {
        abi: Types.ContractAbiInterface;
        bytecode: string;
        constructorParams?: unknown[];
        name?: string;
    }): Promise<{
        address: string;
        txId: string;
    }>;
}
//# sourceMappingURL=signer.d.ts.map