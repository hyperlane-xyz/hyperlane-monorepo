import { MessageTx } from '../explorerTypes.js';

class HyperlaneService {
  async getOriginBlockByMessageId(_messageId: string): Promise<MessageTx> {
    return {
      timestamp: 123456789,
      hash: '0x123abc456def789',
      from: '0x9876543210abcdef',
      to: '0xabcdef0123456789',
      blockHash: '0x456789abc123def',
      blockNumber: 12345,
      mailbox: '0xabcdef0123456789',
      nonce: 0,
      gasLimit: 1000000,
      gasPrice: 100,
      effectiveGasPrice: 90,
      gasUsed: 50000,
      cumulativeGasUsed: 1234567,
      maxFeePerGas: 150,
      maxPriorityPerGas: 100,
    };
  }
}

export { HyperlaneService };
