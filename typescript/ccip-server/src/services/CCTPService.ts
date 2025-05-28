import { ethers } from 'ethers';
import { Router } from 'express';
import { z } from 'zod';

import { IMessageTransmitter__factory } from '@hyperlane-xyz/core';

import { CCTPServiceAbi } from '../abis/CCTPServiceAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService } from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';
import { HyperlaneService } from './HyperlaneService.js';
import { RPCService } from './RPCService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  CCTP_ATTESTATION_URL: z.string().url(),
  RPC_URL: z.string().url(),
});

class CCTPService extends BaseService {
  // External Services
  hyperlaneService: HyperlaneService;
  cctpAttestationService: CCTPAttestationService;
  rpcService: RPCService;
  public readonly router: Router;

  static initialize(): Promise<BaseService> {
    return Promise.resolve(new CCTPService());
  }

  constructor() {
    super();
    const env = EnvSchema.parse(process.env);
    this.hyperlaneService = new HyperlaneService(env.HYPERLANE_EXPLORER_URL);
    this.cctpAttestationService = new CCTPAttestationService(
      env.CCTP_ATTESTATION_URL,
    );
    // TODO: fetch this from a configured MultiProvider from IRegistry
    this.rpcService = new RPCService(env.RPC_URL);

    this.router = Router();

    // CCIP-read spec: GET /getCCTPAttestation/:sender/:callData.json
    this.router.get(
      '/getCctpAttestation/:sender/:callData.json',
      createAbiHandler(
        CCTPServiceAbi,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );

    // CCIP-read spec: POST /getCCTPAttestation
    this.router.post(
      '/getCctpAttestation',
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
    const iface = IMessageTransmitter__factory.createInterface();
    const event = iface.events['MessageSent(bytes)'];

    for (const log of receipt.logs) {
      try {
        const parsedLog = iface.parseLog(log);
        if (parsedLog.name === event.name) {
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
