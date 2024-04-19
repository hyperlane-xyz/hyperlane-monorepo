import { TransactionReceipt } from '@ethersproject/providers';

import { Address } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { GnosisSafeHyperlaneTx } from '../GnosisSafeHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class GnosisSafeTxSubmitter
  implements TxSubmitterInterface<GnosisSafeHyperlaneTx>
{
  constructor(
    public txSubmitterType: TxSubmitterType = TxSubmitterType.IMPERSONATED_ACCOUNT,
    public multiProvider: MultiProvider,
    public chain: ChainNameOrId,
    public userEOA: Address,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
    this.userEOA = userEOA;
  }

  public async sendTxs(
    hyperlaneTx: GnosisSafeHyperlaneTx[],
  ): Promise<TransactionReceipt[]> {
    const txReceipts: TransactionReceipt[] = [];
    for (const populatedTx of hyperlaneTx) {
      const receipt = await this.sendTx(populatedTx);
      txReceipts.push(receipt);
    }
    return txReceipts;
  }

  public async sendTx(
    hyperlaneTx: GnosisSafeHyperlaneTx,
  ): Promise<TransactionReceipt> {
    // const safe = await this.getSafe(hyperlaneTx.safeAddress);

    // TODO: Delete and replace with propose call to Gnosis Safe
    return await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );
  }

  // TODO: Implement. Currently copied from infra/src/utils/safe.ts
  // private async getSafe(safeAddress: Address): Promise<Safe> {
  //   const signer = this.multiProvider.getSigner(this.chain);
  //   const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  //   return Safe.create({
  //     ethAdapter,
  //     safeAddress: safeAddress,
  //   });
  // }
}
