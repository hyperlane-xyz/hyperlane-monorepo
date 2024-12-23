import { utils } from 'ethers';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  ethDispatchEventToStarkMessage,
  toEthMessageBytes,
} from './messageUtils.js';
import { toStarknetMessageBytes } from './messageUtils.js';

export interface MessageAdapter {
  protocol: ProtocolType;
  formatMessageForDispatch(message: any): Promise<{ metadata: any; body: any }>;
  formatMessageForRelay(message: DispatchedMessage): Promise<{
    metadata: any;
    messageData?: any;
  }>;
}

abstract class BaseMessageAdapter implements MessageAdapter {
  abstract protocol: ProtocolType;
  constructor(protected multiProvider: MultiProvider) {}

  abstract formatMessageForDispatch(
    message: any,
  ): Promise<{ metadata: any; body: any }>;

  abstract formatMessageForRelay(message: DispatchedMessage): Promise<{
    metadata: any;
    messageData?: any;
  }>;
}

export class EvmMessageAdapter extends BaseMessageAdapter {
  protocol = ProtocolType.Ethereum;

  async formatMessageForDispatch({ body }: { body: string }) {
    return {
      metadata: '0x0001', // Default EVM metadata
      body: body,
    };
  }

  async formatMessageForRelay(message: DispatchedMessage) {
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destination,
    );

    if (destinationProtocol === ProtocolType.Starknet) {
      return {
        metadata: { size: 0, data: [BigInt(0)] },
        messageData: ethDispatchEventToStarkMessage(message),
      };
    }

    // Default EVM format
    return {
      metadata: '0x',
      messageData: message.message,
    };
  }
}

export class StarknetMessageAdapter extends BaseMessageAdapter {
  protocol = ProtocolType.Starknet;

  async formatMessageForDispatch({ body }: { body: string }) {
    const messageBodyBytes = toStarknetMessageBytes(
      new TextEncoder().encode(body),
    );
    return {
      metadata: { size: 1, data: [BigInt(1)] },
      body: messageBodyBytes,
    };
  }

  async formatMessageForRelay(
    message: DispatchedMessage & {
      parsed: { body: { size: number; data: bigint[] } };
    },
  ) {
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destination,
    );

    if (destinationProtocol === ProtocolType.Ethereum) {
      return {
        metadata: '0x0001',
        messageData: utils.hexlify(toEthMessageBytes(message.parsed as any)),
      };
    }

    return {
      metadata: { size: 1, data: [BigInt(1)] },
      // TODO: Add messageData for Starknet
    };
  }
}
