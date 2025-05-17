import { ethers } from 'ethers';
import { Router } from 'express';

import { CCTPServiceAbi } from '../abis/CCTPServiceAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { CCTPAttestationService } from './CCTPAttestationService.js';
import { HyperlaneService } from './HyperlaneService.js';
import { RPCService } from './RPCService.js';

class CCTPService {
  // External Services
  hyperlaneService: HyperlaneService;
  cctpAttestationService: CCTPAttestationService;
  rpcService: RPCService;
  public readonly router: Router;

  constructor() {
    this.hyperlaneService = new HyperlaneService(
      process.env.HYPERLANE_EXPLORER_URL!,
    );
    this.cctpAttestationService = new CCTPAttestationService(
      process.env.CCTP_ATTESTATION_API!,
    );
    // TODO: fetch this from a configured MultiProvider from IRegistry
    this.rpcService = new RPCService(process.env.RPC_URL!);

    this.router = Router();

    // CCIP-read spec: GET /getCCTPAttestation/:sender/:callData.json
    this.router.get(
      '/getCCTPAttestation/:sender/:callData.json',
      createAbiHandler(
        CCTPServiceAbi,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );

    // CCIP-read spec: POST /getCCTPAttestation
    this.router.post(
      '/getCCTPAttestation',
      createAbiHandler(
        CCTPServiceAbi,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );
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
      } catch (_err) {
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

    const receipt =
      await this.rpcService.provider.getTransactionReceipt(txHash);

    const cctpMessage = await this.getCCTPMessageFromReceipt(receipt);

    const [relayedCctpMessage, attestation] =
      await this.cctpAttestationService.getAttestation(cctpMessage, txHash);

    console.log('cctpMessage', relayedCctpMessage);
    console.log('attestation', attestation);
    return [relayedCctpMessage, attestation];
  }
}

export { CCTPService };
