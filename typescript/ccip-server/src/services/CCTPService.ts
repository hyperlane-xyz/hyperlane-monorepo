import { ethers } from 'ethers';

import { CCTPAttestationService } from './CCTPAttestationService';
import { HyperlaneService } from './HyperlaneService';
import { RPCService } from './RPCService';

type RPCConfig = {
  readonly url: string;
  readonly chainId: string;
};

type HyperlaneConfig = {
  readonly url: string;
};

type CCTPConfig = {
  readonly url: string;
};

class CCTPService {
  // External Services
  hyperlaneService: HyperlaneService;
  cctpAttestationService: CCTPAttestationService;
  rpcService: RPCService;

  constructor(
    hyperlaneConfig: Required<HyperlaneConfig>,
    cctpConfig: Required<CCTPConfig>,
    rpcConfig: Required<RPCConfig>,
  ) {
    this.hyperlaneService = new HyperlaneService(hyperlaneConfig.url);
    this.cctpAttestationService = new CCTPAttestationService(cctpConfig.url);
    this.rpcService = new RPCService(rpcConfig.url);
  }

  async getCCTPMessageFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
  ) {
    // Event from interfaces/cctp/IMessageTransmitter.sol
    const abi = ['event MessageSent(bytes message)'];
    const iface = new ethers.utils.Interface(abi);
    for (const log of receipt.logs) {
      try {
        const parsedLog = iface.parseLog(log);

        if (parsedLog.name === 'MessageSent') {
          return parsedLog.args.message;
        }
      } catch {
        // This log is not from the events in our ABI
        continue;
      }
    }

    throw new Error('Unable to find MessageSent event in logs');
  }

  async getCCTPAttestation(message: string) {
    const messageId: string = ethers.utils.keccak256(message);
    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    console.info('Found tx @', txHash);

    const receipt = await this.rpcService.provider.getTransactionReceipt(
      txHash,
    );

    const cctpMessage = await this.getCCTPMessageFromReceipt(receipt);

    const [relayedCctpMessage, attestation] =
      await this.cctpAttestationService.getAttestation(cctpMessage, txHash);

    console.log('cctpMessage', relayedCctpMessage);
    console.log('attestation', attestation);
    return [relayedCctpMessage, attestation];
  }
}

export { CCTPService };
