import assert from 'assert';
import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { CallData, rootLogger } from '@hyperlane-xyz/utils';

import { InterchainAccount } from '../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { TxSubmitterType } from '../submitter/TxSubmitterTypes.js';

import { TxTransformerInterface } from './TxTransformer.js';
import {
  InterchainAccountTxTransformerProps,
  TxTransformerType,
} from './TxTransformerTypes.js';

export class InterchainAccountTxTransformer<HTX extends HyperlaneTx>
  implements TxTransformerInterface<HTX>
{
  public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA;
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  public readonly interchainAccount: InterchainAccount;

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly originChain: ChainName,
    public readonly destinationChain: ChainName,
    public readonly props: InterchainAccountTxTransformerProps,
  ) {
    this.multiProvider = multiProvider;
    this.originChain = originChain;
    this.destinationChain = destinationChain;
    this.props = props;
    this.interchainAccount = new InterchainAccount(
      this.props.contractsMap,
      this.multiProvider,
    );
  }

  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
    submitterType: TxSubmitterType,
  ): Promise<HTX[]> {
    const hyperlaneTxs: HTX[] = [];
    for (const populatedTx of populatedTxs) {
      const hyperlaneTx = await this.transformTx(populatedTx, submitterType);
      hyperlaneTxs.push(hyperlaneTx);
    }
    return hyperlaneTxs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
    submitterType: TxSubmitterType,
  ): Promise<HTX> {
    this.logger.debug('Transforming to HyperlaneTx...');

    switch (submitterType) {
      case TxSubmitterType.IMPERSONATED_ACCOUNT:
        return await this.transformForImpersonatedAccount(populatedTx);
      case TxSubmitterType.SIGNER:
        return await this.transformForSigner(populatedTx);
      case TxSubmitterType.GNOSIS_SAFE:
        return await this.transformForGnosisSafe(populatedTx);
      default:
        throw new Error(`Unsupported submitter type: ${submitterType}`);
    }
  }

  private async transformForImpersonatedAccount(
    populatedTx: PopulatedTransaction,
  ): Promise<HTX> {
    return await this.transformForEOA(populatedTx);
  }

  private async transformForSigner(
    populatedTx: PopulatedTransaction,
  ): Promise<HTX> {
    return await this.transformForEOA(populatedTx);
  }

  private async transformForGnosisSafe(
    populatedTx: PopulatedTransaction,
  ): Promise<HTX> {
    const to = populatedTx.to;
    const data = populatedTx.data;

    assert(to && data, 'Invalid transaction: Missing required metadata.');

    const callData: CallData = {
      to,
      data,
      value: populatedTx.value,
    };

    return (await this.interchainAccount.getCallRemote(
      this.originChain,
      this.destinationChain,
      [callData],
      this.props.accountConfig,
      this.props.hookMetadata,
    )) as HTX;
  }

  // TODO: Below logic may be different for EOAs (cc @yorhodes)
  private async transformForEOA(
    populatedTx: PopulatedTransaction,
  ): Promise<HTX> {
    const to = populatedTx.to;
    const data = populatedTx.data;

    assert(to && data, 'Invalid transaction: Missing required metadata.');

    const callData: CallData = {
      to,
      data,
      value: populatedTx.value,
    };

    return (await this.interchainAccount.getCallRemote(
      this.originChain,
      this.destinationChain,
      [callData],
      this.props.accountConfig,
      this.props.hookMetadata,
    )) as HTX;
  }
}
