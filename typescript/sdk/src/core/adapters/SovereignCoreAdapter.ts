import { StandardRollup } from '@sovereign-sdk/web3';
import { Address } from 'viem';

import { Domain, HexString } from '@hyperlane-xyz/utils';

import { BaseSovereignAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

// {"data":{"type":"event","number":21,"key":"Mailbox/Dispatch","value":{"dispatch":{"sender":"0xe14e75006fa7444985b9876c71b6a7689631af98658b10598c5151f18490e812","destination_domain":1399811150,"recipient_address":"0x264ae4d8bb90248557e7e039afaf384b64fbc821e56f45ebb524d74dfe8cc30d","message":"0x0300000000000015b3e14e75006fa7444985b9876c71b6a7689631af98658b10598c5151f18490e812536f6c4e264ae4d8bb90248557e7e039afaf384b64fbc821e56f45ebb524d74dfe8cc30dc7589c5b37e68fea5e4d22423ab074446c29f737663905b6def7359547d7cb5e0000000000000000000000000000000000000000000000000000000000000001"}},"module":{"type":"moduleRef","name":"Mailbox"}},"meta":{}}%
type DispatchEvent = {
  dispatch: {
    sender: HexString;
    destination_domain: Domain;
    recipient_address: HexString;
    message: HexString;
  };
};

// {"data":{"type":"event","number":22,"key":"Mailbox/DispatchId","value":{"dispatch_id":{"id":"0x595af9a9099d27cf06dd01c65157287b9b2e338a9e1b9494ded72cc561fcea1d"}},"module":{"type":"moduleRef","name":"Mailbox"}},"meta":{}}
type DispatchIdEvent = {
  dispatch_id: {
    id: HexString;
  };
};

export class SovereignCoreAdapter
  extends BaseSovereignAdapter
  implements ICoreAdapter
{
  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: Record<string, Address>,
  ) {
    super(chainName, multiProvider, addresses);
  }

  public getProvider(): Promise<StandardRollup<any>> {
    return this.multiProvider.getSovereignProvider(this.chainName);
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: HexString; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.Sovereign) {
      throw new Error(
        `Unsupported provider type for SovereignCoreAdapter ${sourceTx.type}`,
      );
    }

    const events = sourceTx.receipt.response.events?.filter(
      (e: any) =>
        e.key === 'Mailbox/DispatchId' || e.key === 'Mailbox/Dispatch',
    );

    if (!events || !events.length) {
      throw new Error('No dispatch events found');
    }

    // Events will always have the pattern `Dispatch` (which contains the destination domain) immediately followed by `DispatchId` (which contains the message id)
    const result = [];
    for (let i = 0; i < events.length; i += 2) {
      const dispatchEvent = events[i];
      const dispatchIdEvent = events[i + 1];

      if (!dispatchEvent || !dispatchIdEvent) break;

      const destinationDomain = (dispatchEvent.value as DispatchEvent).dispatch
        .destination_domain;
      const messageId = (dispatchIdEvent.value as DispatchIdEvent).dispatch_id
        .id;

      result.push({
        messageId,
        destination: this.multiProvider.getChainName(destinationDomain),
      });
    }

    return result;
  }

  waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    throw new Error('Not implemented');
  }
}

