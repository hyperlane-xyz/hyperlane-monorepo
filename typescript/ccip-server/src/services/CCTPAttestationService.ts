import { BytesLike, ethers } from 'ethers';
import { Logger } from 'pino';

import { assert } from '@hyperlane-xyz/utils';

import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

// https://developers.circle.com/api-reference/cctp/all/get-messages-v-2
type DelayReason =
  | 'insufficient_fee'
  | 'amount_above_max'
  | 'insufficient_allowance_available';
type Status = 'complete' | 'pending_confirmations';

interface CCTPMessageEntry {
  attestation: string;
  message: string;
  eventNonce: string;
  // CCTP v2 only
  cctpVersion?: string;
  status?: Status;
  delayReason?: DelayReason;
}

interface CCTPData {
  messages: Array<CCTPMessageEntry>;
}

class CCTPAttestationService {
  url: string;
  serviceName: string;

  CCTP_VERSION_1: bigint = 0n;
  CCTP_VERSION_2: bigint = 1n;

  constructor(serviceName: string, url: string) {
    this.url = url;
    this.serviceName = serviceName;
  }

  _getFieldFromMessage(
    message: string,
    fieldIndex: number,
    fieldOffset: number,
  ): BytesLike {
    return ethers.utils.hexDataSlice(
      message,
      fieldIndex,
      fieldIndex + fieldOffset,
    );
  }

  // Index and offset values retrieved from CctpMessageV2.sol
  _getCCTPVersionFromMessage(message: string): bigint {
    const versionIndex = 0;
    const versionOffset = 4;
    return ethers.BigNumber.from(
      this._getFieldFromMessage(message, versionIndex, versionOffset),
    ).toBigInt();
  }

  // Index and offset values retrieved from CctpMessageV2.sol
  _getSourceDomainFromMessage(message: string): number {
    const sourceDomainIndex = 4;
    const sourceDomainOffset = 4;
    return ethers.BigNumber.from(
      this._getFieldFromMessage(message, sourceDomainIndex, sourceDomainOffset),
    ).toNumber();
  }

  _getAttestationUrlV1(cctpMessage: string, transactionHash: string): string {
    const sourceDomain = this._getSourceDomainFromMessage(cctpMessage);
    return `${this.url}/v1/messages/${sourceDomain}/${transactionHash}`;
  }

  _getAttestationUrlV2(cctpMessage: string, transactionHash: string): string {
    const sourceDomain = this._getSourceDomainFromMessage(cctpMessage);
    return `${this.url}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
  }

  async getAttestation(
    cctpMessage: string,
    transactionHash: string,
    messageId: string,
    logger: Logger,
  ) {
    const version = this._getCCTPVersionFromMessage(cctpMessage);

    const context = {
      cctpMessage,
      transactionHash,
    };

    let url;
    if (version == this.CCTP_VERSION_1) {
      url = this._getAttestationUrlV1(cctpMessage, transactionHash);
    } else if (version == this.CCTP_VERSION_2) {
      url = this._getAttestationUrlV2(cctpMessage, transactionHash);
    } else {
      logger.error(
        {
          ...context,
          version,
          messageId,
          error_reason: UnhandledErrorReason.CCTP_UNSUPPORTED_VERSION,
        },
        'Unsupported CCTP version',
      );
      PrometheusMetrics.logUnhandledError(
        this.serviceName,
        UnhandledErrorReason.CCTP_UNSUPPORTED_VERSION,
      );
      throw new Error(`Unsupported CCTP version: ${version}`);
    }

    const options = {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    const resp = await fetch(url, options);

    if (!resp.ok) {
      if (resp.status === 500) {
        logger.error(
          {
            ...context,
            status: resp.status,
            statusText: resp.statusText,
            url,
            messageId,
            error_reason: UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_500,
          },
          'CCTP attestation request failed',
        );
        PrometheusMetrics.logUnhandledError(
          this.serviceName,
          UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_500,
        );
        throw new Error(`CCTP attestation request failed: ${resp.statusText}`);
      }

      if (resp.status === 404) {
        logger.info(
          {
            ...context,
            status: resp.status,
            statusText: resp.statusText,
            url,
          },
          'CCTP attestation not found',
        );
        throw new Error(`CCTP attestation is pending`);
      }

      // This should not happen according to the CCTP API spec, but we'll log it just in case
      logger.error(
        {
          ...context,
          status: resp.status,
          statusText: resp.statusText,
          url,
          messageId,
          error_reason:
            UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_UNKNOWN_ERROR,
        },
        'CCTP attestation request failed: unknown error',
      );
      PrometheusMetrics.logUnhandledError(
        this.serviceName,
        UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_UNKNOWN_ERROR,
      );
      throw new Error(`CCTP attestation request failed: ${resp.statusText}`);
    }

    let json: CCTPData;
    try {
      json = await resp.json();
    } catch (error) {
      logger.error(
        {
          ...context,
          status: resp.status,
          statusText: resp.statusText,
          url,
          messageId,
          error_reason:
            UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_JSON_PARSE_ERROR,
        },
        'CCTP attestation response parsing failed',
      );
      throw new Error(`CCTP service response parsing failed: ${error}`);
    }

    assert(
      json.messages.length > 0,
      'CCTP attestation API returned no messages',
    );

    // Circle fills in four fields off-chain that are zeroed in the emitted MessageSent bytes.
    // CctpMessageV2 header mutable fields:
    //   - nonce (bytes 12-43): EMPTY_NONCE = bytes32(0) on emit, assigned by Circle
    //   - finalityThresholdExecuted (bytes 144-147): 0 on emit, set by Circle on finality
    // BurnMessageV2 body mutable fields (body starts at byte 148):
    //   - feeExecuted (full bytes 312-343): EMPTY_FEE_EXECUTED = 0 on emit, set by Circle
    //   - expirationBlock (full bytes 344-375): EMPTY_EXPIRATION_BLOCK = 0 on emit, set by Circle
    // Byte-exact comparison always fails for v2. Normalize both sides by zeroing all four fields.
    // GMP messages are 180 bytes so bytes 312-375 are out of range — safe no-op.
    const normalizeCctpMessage = (hex: string): string => {
      const bytes = ethers.utils.arrayify(hex);
      bytes.fill(0, 12, 44); // nonce
      bytes.fill(0, 144, 148); // finalityThresholdExecuted
      if (bytes.length >= 344) bytes.fill(0, 312, 344); // feeExecuted
      if (bytes.length >= 376) bytes.fill(0, 344, 376); // expirationBlock
      return ethers.utils.hexlify(bytes);
    };
    const normalizedCctpMessage = normalizeCctpMessage(cctpMessage);
    const matchingMessage =
      json.messages.find(
        (m) => normalizeCctpMessage(m.message) === normalizedCctpMessage,
      ) ?? json.messages[0];

    if (matchingMessage.attestation === 'PENDING') {
      const errorString = 'CCTP attestation is pending';
      switch (matchingMessage.delayReason) {
        case 'insufficient_fee':
        case 'amount_above_max':
        case 'insufficient_allowance_available':
          PrometheusMetrics.logUnhandledError(
            this.serviceName,
            UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_PENDING,
          );
          logger.error(
            {
              error_reason:
                UnhandledErrorReason.CCTP_ATTESTATION_SERVICE_PENDING,
              ...matchingMessage,
              ...context,
            },
            errorString + ` due to ${matchingMessage.delayReason}`,
          );
          break;
        default:
          logger.info({ ...context, ...matchingMessage }, errorString);
      }
      throw new Error(errorString);
    }

    return [matchingMessage.message, matchingMessage.attestation];
  }
}

export { CCTPAttestationService };
