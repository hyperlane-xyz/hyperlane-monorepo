import { ethers, Wallet } from 'ethers';
import {
  HttpMethod,
  Web2KeeperConfig,
  Web2Request,
  Web2Response,
} from './types.js';
import { Web2Message } from './Web2Message.js';

export class Web2Keeper {
  protected wallets: Wallet[];

  constructor(public readonly config: Web2KeeperConfig) {
    this.wallets = config.privateKeys.map((pk) => new Wallet(pk));
  }

  /**
   * Executes an off-chain HTTP request using fetch.
   */
  async executeHttpRequest(request: Web2Request): Promise<{
    statusCode: number;
    headers: string;
    body: Uint8Array;
  }> {
    const methodStr = HttpMethod[request.method] || 'GET';
    const parsedHeaders = request.headers ? JSON.parse(request.headers) : {};

    let requestBody: any = undefined;
    if (
      request.method !== HttpMethod.GET &&
      request.method !== HttpMethod.HEAD &&
      request.body &&
      request.body !== '0x'
    ) {
      requestBody = Buffer.from(ethers.utils.arrayify(request.body));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs ?? 15000,
    );

    try {
      const res = await fetch(request.url, {
        method: methodStr,
        headers: parsedHeaders,
        body: requestBody,
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const arrayBuffer = await res.arrayBuffer();
      const bodyBytes = new Uint8Array(arrayBuffer);

      return {
        statusCode: res.status,
        headers: JSON.stringify(responseHeaders),
        body: bodyBytes,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Constructs the Web2Response and cryptographic attestation signatures.
   */
  async generateAttestation(params: {
    request: Web2Request;
    httpResult: {
      statusCode: number;
      headers: string;
      body: Uint8Array;
    };
    destinationDomain: number;
    recipientRouterAddress: string;
  }): Promise<{
    response: Web2Response;
    responseBytes: string;
    metadata: string;
    digest: string;
  }> {
    const response: Web2Response = {
      requestId: params.request.requestId,
      callbackAddress: params.request.callbackAddress,
      statusCode: params.httpResult.statusCode,
      headers: params.httpResult.headers,
      responseBody: ethers.utils.hexlify(params.httpResult.body),
      callbackData: params.request.callbackData,
    };

    const responseBytes = Web2Message.encodeResponse(response);
    const endpointHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(params.request.url),
    );
    const timestamp = Math.floor(Date.now() / 1000);

    // Format message to compute ID
    const recipientBytes32 = ethers.utils.hexZeroPad(
      params.recipientRouterAddress,
      32,
    );

    const rawMessage = ethers.utils.concat([
      ethers.utils.arrayify('0x00'), // version 0
      ethers.utils.zeroPad(ethers.utils.hexlify(1), 4), // nonce
      ethers.utils.zeroPad(ethers.utils.hexlify(this.config.web2Domain), 4), // origin
      ethers.utils.arrayify(endpointHash), // sender (endpointHash)
      ethers.utils.zeroPad(ethers.utils.hexlify(params.destinationDomain), 4), // destination
      ethers.utils.arrayify(recipientBytes32), // recipient
      ethers.utils.arrayify(responseBytes), // body
    ]);

    const messageId = ethers.utils.keccak256(rawMessage);
    const bodyHash = ethers.utils.keccak256(responseBytes);

    const structHash = ethers.utils.solidityKeccak256(
      [
        'uint32',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint64',
        'bytes32',
        'bytes32',
      ],
      [
        this.config.web2Domain,
        endpointHash,
        recipientBytes32,
        messageId,
        endpointHash,
        timestamp,
        params.request.requestId,
        bodyHash,
      ],
    );

    const messageDigest = ethers.utils.arrayify(structHash);

    // Collect and sort signatures by signer address ascending
    const signerSignatures: { address: string; signature: string }[] = [];
    for (const wallet of this.wallets) {
      const rawSig = await wallet.signMessage(messageDigest);
      signerSignatures.push({
        address: wallet.address.toLowerCase(),
        signature: rawSig,
      });
    }

    signerSignatures.sort((a, b) => (a.address < b.address ? -1 : 1));

    const metadata = Web2Message.formatIsmMetadata({
      endpointHash,
      timestamp,
      requestId: params.request.requestId,
      signatures: signerSignatures.map((s) => s.signature),
    });

    return {
      response,
      responseBytes,
      metadata,
      digest: structHash,
    };
  }
}
