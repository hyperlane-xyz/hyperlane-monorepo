import { AbiCoder } from '@ethersproject/abi';

import { IL2toL2CrossDomainMessenger__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

interface NativeInteropMessage {
  originSender: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  chainId: number;
  payload: string;
}

function concatHex(strings: string[]): string {
  return '0x' + strings.map((s) => s.slice(2)).join('');
}

export class SuperchainMetadataBuilder implements MetadataBuilder {
  constructor(
    protected readonly core: HyperlaneCore,
    protected readonly logger = rootLogger.child({
      module: 'ArbL2ToL1MetadataBuilder',
    }),
  ) {}

  async build(context: MetadataContext): Promise<string> {
    const provider = this.core.multiProvider.getProvider(
      context.message.parsed.origin,
    );
    const logs = context.dispatchTx.logs;
    // Find the native interop message
    const messengerInterface =
      IL2toL2CrossDomainMessenger__factory.createInterface();
    const nativeInteropMessages = (
      await Promise.all(
        logs.map(async (log) => {
          try {
            const parsed = messengerInterface.parseLog(log);
            if (parsed.name === 'SentMessage') {
              const block = await provider.getBlock(log.blockHash);
              const nativeInteropMessage: NativeInteropMessage = {
                originSender: log.address,
                logIndex: log.logIndex,
                blockNumber: log.blockNumber,
                timestamp: block.timestamp,
                chainId: this.core.multiProvider.getDomainId(
                  context.message.parsed.origin,
                ),
                payload: concatHex([...log.topics, log.data]),
              };
              // Only match if the message ID is in the payload
              if (
                nativeInteropMessage.payload.includes(
                  context.message.id.slice(2),
                )
              ) {
                return [nativeInteropMessage];
              } else {
                return [];
              }
            }
            return [];
          } catch (e) {
            return [];
          }
        }),
      )
    ).flat();
    if (nativeInteropMessages.length != 1) {
      throw Error('No native interop message found for message');
    }
    const nativeInteropMessage = nativeInteropMessages[0];
    const coder = new AbiCoder();
    const metadata = coder.encode(
      ['address', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
      [
        nativeInteropMessage.originSender,
        nativeInteropMessage.blockNumber,
        nativeInteropMessage.logIndex,
        nativeInteropMessage.timestamp,
        nativeInteropMessage.chainId,
        nativeInteropMessage.payload,
      ],
    );
    return metadata;
  }
}
