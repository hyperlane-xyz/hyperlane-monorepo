import { type AnnotatedTx, type TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { type ContractType } from '@hyperlane-xyz/starknet-core';
export type StarknetInvokeTx = AnnotatedTx & {
    kind: 'invoke';
    contractAddress: string;
    entrypoint: string;
    calldata: any[];
};
export type StarknetDeployTx = AnnotatedTx & {
    kind: 'deploy';
    contractName: string;
    contractType?: ContractType;
    constructorArgs: any[];
};
export type StarknetAnnotatedTx = StarknetInvokeTx | StarknetDeployTx;
export type StarknetTxReceipt = TxReceipt & {
    transactionHash: string;
    receipt?: any;
    contractAddress?: string;
};
//# sourceMappingURL=types.d.ts.map