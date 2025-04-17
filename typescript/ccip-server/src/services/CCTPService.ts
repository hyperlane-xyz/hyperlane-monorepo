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

  async getCCTPMessageFromReceipt(receipt: any): Promise<any> {
    const abi = ['event MessageSent(bytes message)'];
    const iface = new ethers.utils.Interface(abi);
    for (const log of receipt.logs) {
      try {
        const parsedLog = iface.parseLog(log);

        if (parsedLog.name === 'MessageSent') {
          return parsedLog.args.message;
        }
      } catch (err) {
        // This log is not from the events in our ABI
        continue;
      }
    }

    throw new Error('Unable to find MessageSent event in logs');
  }

  async getCCTPNonceFromMessage(message: any): Promise<bigint> {
    const NONCE_INDEX = 12;
    const nonceByteArray = ethers.utils.hexDataSlice(
      message,
      NONCE_INDEX,
      NONCE_INDEX + 8,
    );
    return ethers.BigNumber.from(nonceByteArray).toBigInt();
  }

  async getSourceDomainFromMessage(message: string): Promise<number> {
    const SOURCE_DOMAIN_INDEX = 4;
    const sourceDomainByteArray = ethers.utils.hexDataSlice(
      message,
      SOURCE_DOMAIN_INDEX,
      SOURCE_DOMAIN_INDEX + 4,
    );
    return ethers.BigNumber.from(sourceDomainByteArray).toNumber();
  }

  async getCCTPAttestation([message]: ethers.utils.Result): Promise<
    Array<any>
  > {
    const messageId: string = ethers.utils.keccak256(message);
    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    // const txHash = message as string;

    console.info('Found tx @', txHash);

    const receipt = await this.rpcService.provider.getTransactionReceipt(
      txHash,
    );

    const cctpMessage = await this.getCCTPMessageFromReceipt(receipt);

    const messageHash = ethers.utils.keccak256(cctpMessage);
    const attestation = await this.cctpAttestationService.getAttestationV1(
      messageHash,
    );

    console.log('messageHash', messageHash);
    console.log('cctpMessage', cctpMessage);
    console.log('attestation', attestation);
    return [cctpMessage, attestation];
  }
}

export { CCTPService };
