import { ProtocolType } from '@hyperlane-xyz/utils';

import { MessageAdapter } from './MessageAdapter.js';

export class MessageAdapterRegistry {
  private adapters = new Map<ProtocolType, MessageAdapter>();

  register(adapter: MessageAdapter) {
    this.adapters.set(adapter.protocol, adapter);
  }

  getAdapter(protocol: ProtocolType): MessageAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new Error(`No adapter registered for protocol ${protocol}`);
    }
    return adapter;
  }
}
