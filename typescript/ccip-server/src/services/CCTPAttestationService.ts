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

  _getAttestationUrlV1(sourceDomain: number, transactionHash: string): string {
    return `${this.url}/v1/messages/${sourceDomain}/${transactionHash}`;
  }

  _getAttestationUrlV2(sourceDomain: number, transactionHash: string): string {
    return `${this.url}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
  }

  /**
   * `messageInfo` is a discriminated union because the two origin VM types resolve
   * `version`/`sourceDomain` differently:
   *  - EVM: derived from the raw CCTP message bytes recovered from the origin
   *    receipt's `MessageSent` log — also used below to disambiguate a
   *    multi-message transaction by byte-exact comparison.
   *  - Sealevel: there's no EVM-style receipt/log to recover message bytes from
   *    (Circle's Sealevel programs persist the message in an on-chain account
   *    instead), so callers pass the statically-known domain/version instead.
   *    Disambiguation isn't possible without the message bytes, so this path
   *    only supports the (99.99%-common) single-message-per-transaction case.
   */
  async getAttestation(
    transactionHash: string,
    messageId: string,
    logger: Logger,
    messageInfo:
      | { cctpMessage: string }
      | { sourceDomain: number; version: bigint },
  ) {
    const version =
      'cctpMessage' in messageInfo
        ? this._getCCTPVersionFromMessage(messageInfo.cctpMessage)
        : messageInfo.version;
    const sourceDomain =
      'cctpMessage' in messageInfo
        ? this._getSourceDomainFromMessage(messageInfo.cctpMessage)
        : messageInfo.sourceDomain;

    const context = {
      ...('cctpMessage' in messageInfo
        ? { cctpMessage: messageInfo.cctpMessage }
        : { sourceDomain }),
      transactionHash,
    };

    let url;
    if (version == this.CCTP_VERSION_1) {
      url = this._getAttestationUrlV1(sourceDomain, transactionHash);
    } else if (version == this.CCTP_VERSION_2) {
      url = this._getAttestationUrlV2(sourceDomain, transactionHash);
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

    // Fast path: single message in the tx — no disambiguation needed (99.99% of traffic).
    // Multi-message path: normalize to account for Circle-populated mutable fields and find
    // the entry that corresponds to the cctpMessage bytes extracted from the receipt.
    // For v2: four fields are zeroed at emit and populated by Circle off-chain:
    //   Header: nonce (12-43), finalityThresholdExecuted (144-147)
    //   BurnMessageV2 body: feeExecuted (312-343), expirationBlock (344-375)
    //   GMP messages are 180 bytes so 312-375 are out of range — safe no-op.
    // For v1: byte-exact comparison — applying v2 normalization would corrupt stable
    //   sender/recipient fields (v1 nonce is uint64 at 12-19; bytes 20+ are stable).
    let matchingMessage: CCTPMessageEntry;
    if (json.messages.length === 1) {
      matchingMessage = json.messages[0];
    } else if (!('cctpMessage' in messageInfo)) {
      // No local message bytes to disambiguate with (Sealevel origin) — refuse
      // to guess which entry belongs to this message rather than risk pairing
      // the wrong message with the wrong attestation.
      logger.error(
        { ...context, messageId, messageCount: json.messages.length },
        'Cannot disambiguate multiple CCTP messages without message bytes',
      );
      throw new Error(
        `Cannot disambiguate ${json.messages.length} CCTP messages for ${messageId} without decoded message bytes`,
      );
    } else {
      const cctpMessage = messageInfo.cctpMessage;
      const normalizeCctpMessageV2 = (hex: string): string => {
        const bytes = ethers.utils.arrayify(hex);
        bytes.fill(0, 12, 44); // nonce
        bytes.fill(0, 144, 148); // finalityThresholdExecuted
        if (bytes.length >= 344) bytes.fill(0, 312, 344); // feeExecuted
        if (bytes.length >= 376) bytes.fill(0, 344, 376); // expirationBlock
        return ethers.utils.hexlify(bytes);
      };
      const normalizedCctpMessage =
        version === this.CCTP_VERSION_2
          ? normalizeCctpMessageV2(cctpMessage)
          : cctpMessage.toLowerCase();
      const found = json.messages.find((m) => {
        if (m.message == null) return false; // Circle returns null for messages still being processed
        const normalizedApiMessage =
          version === this.CCTP_VERSION_2
            ? normalizeCctpMessageV2(m.message)
            : m.message.toLowerCase();
        return normalizedApiMessage === normalizedCctpMessage;
      });
      if (found == null) {
        logger.info(
          { messageId, messageCount: json.messages.length },
          'Could not match Circle API messages to cctpMessage — treating as pending',
        );
        throw new Error('CCTP attestation is pending');
      }
      matchingMessage = found;
    }

    if (
      matchingMessage.message == null ||
      matchingMessage.attestation == null ||
      matchingMessage.attestation === 'PENDING'
    ) {
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
