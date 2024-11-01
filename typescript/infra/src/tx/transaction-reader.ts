import { decodeMultiSendData } from '@safe-global/protocol-kit/dist/src/utils/index.js';

import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  HyperlaneReader,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { getHyperlaneCore } from '../../scripts/core-utils.js';
import { DeployEnvironment } from '../config/environment.js';

export abstract class TransactionReader {
  async read(chain: ChainName, tx: any): Promise<any> {
    throw new Error('Not implemented');
  }
}

export class GnosisMultisendReader extends TransactionReader {
  constructor(multiProvider: MultiProvider) {
    super();
  }

  async read(chain: ChainName, tx: AnnotatedEV5Transaction): Promise<any> {
    if (!tx.data) {
      return undefined;
    }
    const multisends = decodeMultiSendData(tx.data);

    return multisends;
  }
}

export class GenericTransactionReader extends HyperlaneReader {
  constructor(
    readonly environment: DeployEnvironment,
    readonly multiProvider: MultiProvider,
    readonly chainAddresses: ChainMap<Record<string, string>>,
  ) {
    super();
  }

  async read(chain: ChainName, tx: AnnotatedEV5Transaction): Promise<any> {
    // If it's an ICA
    if (this.isIcaTransaction(chain, tx)) {
      return this.readIcaTransaction(chain, tx);
    }
  }

  private async readIcaTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<any> {
    // TODO
  }

  private isIcaTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].interchainAccountRouter)
    );
  }
}
