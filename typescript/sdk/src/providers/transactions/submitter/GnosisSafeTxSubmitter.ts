import { Provider, TransactionReceipt } from '@ethersproject/providers';

import { ChainNameOrId } from '../../../types.js';
import { GnosisSafeHyperlaneTx } from '../GnosisSafeHyperlaneTx.js';
import { InterchainAccountHyperlaneTx } from '../InterchainAccountHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class GnosisSafeTxSubmitter
  implements
    TxSubmitterInterface<GnosisSafeHyperlaneTx | InterchainAccountHyperlaneTx>
{
  public txSubmitterType: TxSubmitterType = TxSubmitterType.GNOSIS_SAFE;

  constructor(public provider: Provider, public chain: ChainNameOrId) {
    this.provider = provider;
    this.chain = chain;
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
    const txnHash = await this.provider.call(hyperlaneTx.populatedTx);
    return await this.provider.waitForTransaction(txnHash);
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
