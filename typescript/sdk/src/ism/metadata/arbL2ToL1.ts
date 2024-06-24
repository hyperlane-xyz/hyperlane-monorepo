import { L2ToL1MessageReader } from '@arbitrum/sdk';
import { L2ToL1TransactionEvent } from '@arbitrum/sdk/dist/lib/message/L2ToL1Message.js';
import { assert } from 'console';

import { ArbSys__factory } from '@hyperlane-xyz/core';
import { WithAddress, eqAddressEvm, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { ArbL2ToL1HookConfig } from '../../hook/types.js';
import { ArbL2ToL1IsmConfig, IsmType } from '../types.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

const ArbSys = ArbSys__factory.createInterface();

export class ArbL2ToL1MetadataBuilder implements MetadataBuilder {
  constructor(
    protected readonly core: HyperlaneCore,
    protected readonly logger = rootLogger.child({
      module: 'ArbL2ToL1MetadataBuilder',
    }),
  ) {}

  async build(
    context: MetadataContext<
      WithAddress<ArbL2ToL1IsmConfig>,
      WithAddress<ArbL2ToL1HookConfig>
    >,
  ): Promise<string> {
    assert(context.ism.type === IsmType.ARB_L2_TO_L1, 'Invalid ISM type');
    this.logger.debug({ context }, 'Building ArbL2ToL1 metadata');

    const matchingL2Tx = context.dispatchTx.logs
      .filter((log) => eqAddressEvm(log.address, context.hook.arbSys))
      .map((log) => ArbSys.parseLog(log))
      .find((log) => {
        const calldata: string = log.args.data;
        const messageIdHex = context.message.id.slice(2);
        return calldata.includes(messageIdHex);
      });

    assert(matchingL2Tx, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2Tx }, 'Found matching L2ToL1Tx event');

    if (matchingL2Tx) {
      const l2ToL1TxEvent: L2ToL1TransactionEvent = {
        ...matchingL2Tx.args,
        caller: matchingL2Tx.args.caller,
        destination: matchingL2Tx.args.destination,
        hash: matchingL2Tx.args.hash,
        position: matchingL2Tx.args.position,
        arbBlockNum: matchingL2Tx.args.arbBlockNum,
        ethBlockNum: matchingL2Tx.args.ethBlockNum,
        timestamp: matchingL2Tx.args.timestamp,
        callvalue: matchingL2Tx.args.callvalue,
        data: matchingL2Tx.args.data,
      };

      const reader = new L2ToL1MessageReader(
        this.core.multiProvider.getProvider('sepolia'),
        l2ToL1TxEvent,
      );
      const status = await reader.status(
        this.core.multiProvider.getProvider('arbitrumsepolia'),
      );
      console.log('ELLISH status: ', status);
      // const proof = await reader.getOutboxProof(
      //   this.core.multiProvider.getProvider('arbitrumsepolia'),
      // );
      // console.log('ELLISH proof: ', JSON.stringify(proof, null, 4));
    }

    return 'ArbL2ToL1MetadataBuilder';
  }
}
