import {
  ChainName,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { HexString, ProtocolType } from '@hyperlane-xyz/utils';

export interface ChainAddress {
  address: string;
  chainName?: ChainName;
}

export interface AccountInfo {
  protocol: ProtocolType;
  // This needs to be an array instead of a single address b.c.
  // Cosmos wallets have different addresses per chain
  addresses: Array<ChainAddress>;
  // And another Cosmos exception, public keys are needed
  // for tx simulation and gas estimation
  publicKey?: Promise<HexString>;
  isReady: boolean;
}

export interface WalletDetails {
  name?: string;
  logoUrl?: string;
}

export interface ActiveChainInfo {
  chainDisplayName?: string;
  chainName?: ChainName;
}

export type SendTransactionsFn<
  TxReq extends WarpTypedTransaction = WarpTypedTransaction,
  TxResp extends TypedTransactionReceipt = TypedTransactionReceipt,
> = (params: {
  txs: TxReq[];
  chainName: ChainName;
  activeChainName?: ChainName;
}) => Promise<{ confirm: () => Promise<TxResp[]> }>;

export type SwitchNetworkFn = (chainName: ChainName) => Promise<void>;

export interface ChainTransactionFns {
  sendTransactions: SendTransactionsFn;
  switchNetwork?: SwitchNetworkFn;
}
