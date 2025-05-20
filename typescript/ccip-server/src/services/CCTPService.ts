import { ethers } from 'ethers';
import { Router } from 'express';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { parseMessage } from '@hyperlane-xyz/utils';

import { CCTPServiceAbi } from '../abis/CCTPServiceAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService } from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';
import { HyperlaneService } from './HyperlaneService.js';

class CCTPService extends BaseService {
  // External Services
  hyperlaneService: HyperlaneService;
  cctpAttestationService: CCTPAttestationService;
  multiProvider: MultiProvider | undefined;
  public readonly router: Router;

  static initialize(): Promise<BaseService> {
    return Promise.resolve(new CCTPService());
  }

  constructor() {
    super();
    this.hyperlaneService = new HyperlaneService(
      process.env.HYPERLANE_EXPLORER_API!,
    );
    this.cctpAttestationService = new CCTPAttestationService(
      process.env.CCTP_ATTESTATION_API!,
    );
    const registry = getRegistry({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      enableProxy: true,
    });

    const initializeMultiProvider = async () => {
      const k = await registry.getMetadata();
      this.multiProvider = new MultiProvider(k);
    };
    initializeMultiProvider()
      .then(() => console.info('Initialized MultiProvider'))
      .catch((err) => {
        console.error('Initializing MultiProvider failed', err);
      });

    this.router = Router();

    // CCIP-read spec: GET /getProofs/:sender/:callData.json
    this.router.get(
      '/getProofs/:sender/:callData.json',
      createAbiHandler(
        CCTPServiceAbi,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );

    // CCIP-read spec: POST /getProofs
    this.router.post(
      '/getProofs',
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

    const parsedMessage = parseMessage(message);

    if (this.multiProvider == undefined) {
      throw new Error('MultiProvider not initialized yet');
    }

    const receipt = await this.multiProvider
      .getProvider(parsedMessage.origin)
      .getTransactionReceipt(txHash);
    const cctpMessage = await this.getCCTPMessageFromReceipt(receipt);

    const [relayedCctpMessage, attestation] =
      await this.cctpAttestationService.getAttestation(cctpMessage, txHash);

    console.info(
      `Fetched attestation. messageId=${messageId}, attestation=${attestation}`,
    );
    return [relayedCctpMessage, attestation];
  }
}

export { CCTPService };
