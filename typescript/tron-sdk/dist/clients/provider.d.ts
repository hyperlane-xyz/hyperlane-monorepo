import { TronWeb } from 'tronweb';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { TronSDKOptions, TronSDKTransaction } from '../utils/types.js';
/**
 * TronProvider implements the IProvider interface for Tron.
 * Since Tron is EVM-compatible at the bytecode level, we can deploy
 * the same Solidity contracts. The main differences are:
 * - Address format (Base58Check vs hex)
 * - RPC interface (TronWeb vs ethers)
 * - Transaction structure
 */
export declare class TronProvider implements AltVM.IProvider<TronSDKTransaction> {
    protected tronWeb: TronWeb;
    protected rpcUrls: string[];
    protected chainId: number;
    static connect(rpcUrls: string[], chainId: string | number, _extraParams?: Record<string, unknown>): Promise<TronProvider>;
    constructor(options: TronSDKOptions);
    isHealthy(): Promise<boolean>;
    getRpcUrls(): string[];
    getHeight(): Promise<number>;
    getBalance(req: AltVM.ReqGetBalance): Promise<bigint>;
    getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint>;
    /**
     * Get current energy price from the network.
     * Energy price is returned as a comma-separated string of "timestamp:price" pairs.
     * We take the latest (last) price.
     */
    getEnergyPrice(): Promise<number>;
    estimateTransactionFee(req: AltVM.ReqEstimateTransactionFee<TronSDKTransaction>): Promise<AltVM.ResEstimateTransactionFee>;
    getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox>;
    isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean>;
    getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType>;
    getMessageIdMultisigIsm(req: AltVM.ReqMessageIdMultisigIsm): Promise<AltVM.ResMessageIdMultisigIsm>;
    getMerkleRootMultisigIsm(req: AltVM.ReqMerkleRootMultisigIsm): Promise<AltVM.ResMerkleRootMultisigIsm>;
    getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm>;
    getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm>;
    getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType>;
    getInterchainGasPaymasterHook(req: AltVM.ReqGetInterchainGasPaymasterHook): Promise<AltVM.ResGetInterchainGasPaymasterHook>;
    getMerkleTreeHook(req: AltVM.ReqGetMerkleTreeHook): Promise<AltVM.ResGetMerkleTreeHook>;
    getNoopHook(req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook>;
    getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken>;
    getRemoteRouters(req: AltVM.ReqGetRemoteRouters): Promise<AltVM.ResGetRemoteRouters>;
    getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint>;
    quoteRemoteTransfer(req: AltVM.ReqQuoteRemoteTransfer): Promise<AltVM.ResQuoteRemoteTransfer>;
    getCreateMailboxTransaction(_req: AltVM.ReqCreateMailbox): Promise<TronSDKTransaction>;
    getSetDefaultIsmTransaction(_req: AltVM.ReqSetDefaultIsm): Promise<TronSDKTransaction>;
    getSetDefaultHookTransaction(_req: AltVM.ReqSetDefaultHook): Promise<TronSDKTransaction>;
    getSetRequiredHookTransaction(_req: AltVM.ReqSetRequiredHook): Promise<TronSDKTransaction>;
    getSetMailboxOwnerTransaction(_req: AltVM.ReqSetMailboxOwner): Promise<TronSDKTransaction>;
    getCreateMerkleRootMultisigIsmTransaction(_req: AltVM.ReqCreateMerkleRootMultisigIsm): Promise<TronSDKTransaction>;
    getCreateMessageIdMultisigIsmTransaction(_req: AltVM.ReqCreateMessageIdMultisigIsm): Promise<TronSDKTransaction>;
    getCreateRoutingIsmTransaction(_req: AltVM.ReqCreateRoutingIsm): Promise<TronSDKTransaction>;
    getSetRoutingIsmRouteTransaction(_req: AltVM.ReqSetRoutingIsmRoute): Promise<TronSDKTransaction>;
    getRemoveRoutingIsmRouteTransaction(_req: AltVM.ReqRemoveRoutingIsmRoute): Promise<TronSDKTransaction>;
    getSetRoutingIsmOwnerTransaction(_req: AltVM.ReqSetRoutingIsmOwner): Promise<TronSDKTransaction>;
    getCreateNoopIsmTransaction(_req: AltVM.ReqCreateNoopIsm): Promise<TronSDKTransaction>;
    getCreateMerkleTreeHookTransaction(_req: AltVM.ReqCreateMerkleTreeHook): Promise<TronSDKTransaction>;
    getCreateInterchainGasPaymasterHookTransaction(_req: AltVM.ReqCreateInterchainGasPaymasterHook): Promise<TronSDKTransaction>;
    getSetInterchainGasPaymasterHookOwnerTransaction(_req: AltVM.ReqSetInterchainGasPaymasterHookOwner): Promise<TronSDKTransaction>;
    getSetDestinationGasConfigTransaction(_req: AltVM.ReqSetDestinationGasConfig): Promise<TronSDKTransaction>;
    getRemoveDestinationGasConfigTransaction(_req: AltVM.ReqRemoveDestinationGasConfig): Promise<TronSDKTransaction>;
    getCreateNoopHookTransaction(_req: AltVM.ReqCreateNoopHook): Promise<TronSDKTransaction>;
    getCreateValidatorAnnounceTransaction(_req: AltVM.ReqCreateValidatorAnnounce): Promise<TronSDKTransaction>;
    getCreateNativeTokenTransaction(_req: AltVM.ReqCreateNativeToken): Promise<TronSDKTransaction>;
    getCreateCollateralTokenTransaction(_req: AltVM.ReqCreateCollateralToken): Promise<TronSDKTransaction>;
    getCreateSyntheticTokenTransaction(_req: AltVM.ReqCreateSyntheticToken): Promise<TronSDKTransaction>;
    getSetTokenOwnerTransaction(_req: AltVM.ReqSetTokenOwner): Promise<TronSDKTransaction>;
    getSetTokenIsmTransaction(_req: AltVM.ReqSetTokenIsm): Promise<TronSDKTransaction>;
    getSetTokenHookTransaction(_req: AltVM.ReqSetTokenHook): Promise<TronSDKTransaction>;
    getEnrollRemoteRouterTransaction(_req: AltVM.ReqEnrollRemoteRouter): Promise<TronSDKTransaction>;
    getUnenrollRemoteRouterTransaction(_req: AltVM.ReqUnenrollRemoteRouter): Promise<TronSDKTransaction>;
    getTransferTransaction(_req: AltVM.ReqTransfer): Promise<TronSDKTransaction>;
    getRemoteTransferTransaction(_req: AltVM.ReqRemoteTransfer): Promise<TronSDKTransaction>;
}
//# sourceMappingURL=provider.d.ts.map