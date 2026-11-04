import { ethers } from 'ethers';
import {
  HttpMethod,
  MessageType,
  Web2Request,
  Web2Response,
  Web2IsmMetadataConfig,
} from './types.js';

const defaultAbiCoder = ethers.utils.defaultAbiCoder;

export class Web2Message {
  /**
   * Encodes an outgoing Web2 API request for Mailbox dispatch.
   */
  static encodeRequest(req: Web2Request): string {
    return defaultAbiCoder.encode(
      [
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'string',
        'string',
        'bytes',
        'bytes32',
        'bytes',
      ],
      [
        MessageType.REQUEST,
        req.requestId,
        req.sender,
        req.method,
        req.url,
        req.headers,
        req.body,
        req.callbackAddress,
        req.callbackData,
      ],
    );
  }

  /**
   * Decodes an incoming Web2 API request message body.
   */
  static decodeRequest(data: string): Web2Request {
    const [
      msgType,
      requestId,
      sender,
      method,
      url,
      headers,
      body,
      callbackAddress,
      callbackData,
    ] = defaultAbiCoder.decode(
      [
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'string',
        'string',
        'bytes',
        'bytes32',
        'bytes',
      ],
      data,
    );

    if (msgType !== MessageType.REQUEST) {
      throw new Error(`Invalid message type for request: ${msgType}`);
    }

    return {
      requestId,
      sender,
      method: method as HttpMethod,
      url,
      headers,
      body,
      callbackAddress,
      callbackData,
    };
  }

  /**
   * Encodes a Web2 API response message body for Mailbox delivery.
   */
  static encodeResponse(resp: Web2Response): string {
    return defaultAbiCoder.encode(
      ['uint8', 'bytes32', 'bytes32', 'uint256', 'string', 'bytes', 'bytes'],
      [
        MessageType.RESPONSE,
        resp.requestId,
        resp.callbackAddress,
        resp.statusCode,
        resp.headers,
        resp.responseBody,
        resp.callbackData,
      ],
    );
  }

  /**
   * Decodes an incoming Web2 API response message body.
   */
  static decodeResponse(data: string): Web2Response {
    const [
      msgType,
      requestId,
      callbackAddress,
      statusCode,
      headers,
      responseBody,
      callbackData,
    ] = defaultAbiCoder.decode(
      ['uint8', 'bytes32', 'bytes32', 'uint256', 'string', 'bytes', 'bytes'],
      data,
    );

    if (msgType !== MessageType.RESPONSE) {
      throw new Error(`Invalid message type for response: ${msgType}`);
    }

    return {
      requestId,
      callbackAddress,
      statusCode: statusCode.toNumber(),
      headers,
      responseBody,
      callbackData,
    };
  }

  /**
   * Computes the EIP-191 digest to be signed by Web2 ISM oracle keepers.
   */
  static computeDigest(params: {
    originDomain: number;
    sender: string;
    recipient: string;
    messageId: string;
    endpointHash: string;
    timestamp: number;
    requestId: string;
    bodyHash: string;
  }): string {
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
        params.originDomain,
        params.sender,
        params.recipient,
        params.messageId,
        params.endpointHash,
        params.timestamp,
        params.requestId,
        params.bodyHash,
      ],
    );

    // EIP-191 signed data format: keccak256("\x19Ethereum Signed Message:\n32" + structHash)
    return ethers.utils.hashMessage(ethers.utils.arrayify(structHash));
  }

  /**
   * Formats metadata for the Web2SecurityModule ISM.
   * [endpointHash (32 bytes)][timestamp (8 bytes)][requestId (32 bytes)][signatures (65 bytes each...)]
   */
  static formatIsmMetadata(config: Web2IsmMetadataConfig): string {
    const endpointHashBytes = ethers.utils.arrayify(config.endpointHash);
    const timestampBytes = ethers.utils.zeroPad(
      ethers.utils.hexlify(config.timestamp),
      8,
    );
    const requestIdBytes = ethers.utils.arrayify(config.requestId);

    const signaturesBytes = ethers.utils.concat(
      config.signatures.map((sig) => ethers.utils.arrayify(sig)),
    );

    return ethers.utils.hexlify(
      ethers.utils.concat([
        endpointHashBytes,
        timestampBytes,
        requestIdBytes,
        signaturesBytes,
      ]),
    );
  }
}
