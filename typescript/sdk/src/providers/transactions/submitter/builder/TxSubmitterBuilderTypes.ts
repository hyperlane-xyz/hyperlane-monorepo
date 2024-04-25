import { ChainName } from '../../../../types.js';
import { HyperlaneTx } from '../../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../../HyperlaneTxReceipt.js';
import { TxTransformerInterface } from '../../transformer/TxTransformer.js';
import {
  InterchainAccountTxTransformerProps,
  TxTransformerType,
} from '../../transformer/TxTransformerTypes.js';
import { TxSubmitterInterface } from '../TxSubmitter.js';
import {
  GnosisSafeTxSubmitterProps,
  ImpersonatedAccountTxSubmitterProps,
  TxSubmitterType,
} from '../TxSubmitterTypes.js';

type XOR<T, U> = T | U extends object
  ? (Exclude<T, U> & U) | (Exclude<U, T> & T)
  : T | U;

export type TxSubmitterXORType<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> = XOR<
  {
    submitter: TxSubmitterInterface<HTX, HTR>;
  },
  {
    type: TxSubmitterType;
    chain: ChainName;
    gnosisSafeTxSubmitterProps?: GnosisSafeTxSubmitterProps;
    impersonatedAccountTxSubmitterProps?: ImpersonatedAccountTxSubmitterProps;
  }
>;
export type TxTransformerXORType<HTX extends HyperlaneTx> = XOR<
  {
    transformer: TxTransformerInterface<HTX>;
  },
  {
    type: TxTransformerType;
    chain: ChainName;
    interchainAccountTxTransformerProps?: InterchainAccountTxTransformerProps;
  }
>;
