import { BytesLike } from 'ethers';
import { ethers } from 'ethers';

interface CCTPMessageEntry {
  attestation: string;
  message: string;
}

interface CCTPData {
  messages: Array<CCTPMessageEntry>;
}

class CCTPAttestationService {
  url: string;

  CCTP_VERSION_1: bigint = 0n;
  CCTP_VERSION_2: bigint = 1n;

  constructor(url: string) {
    this.url = url;
  }

  _getFieldFromMessage(
    message: any,
    fieldIndex: number,
    fieldOffset: number,
  ): BytesLike {
    return ethers.utils.hexDataSlice(
      message,
      fieldIndex,
      fieldIndex + fieldOffset,
    );
  }

  _getCCTPVersionFromMessage(message: any): bigint {
    return ethers.BigNumber.from(
      this._getFieldFromMessage(message, 0, 4),
    ).toBigInt();
  }

  _getCCTPNonceFromMessage(message: any): bigint {
    return ethers.BigNumber.from(
      this._getFieldFromMessage(message, 12, 8),
    ).toBigInt();
  }

  _getSourceDomainFromMessage(message: string): number {
    return ethers.BigNumber.from(
      this._getFieldFromMessage(message, 4, 4),
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

  /**
   * Get the CCTP v2 attestation
   * @param CCTP message retrieved from the MessageSend log event
   * @param transaction hash containing the MessageSent event
   * @returns the attestation byte array
   */
  async getAttestation(
    cctpMessage: string,
    transactionHash: string,
  ): Promise<any> {
    const version = this._getCCTPVersionFromMessage(cctpMessage);

    let url;
    if (version == this.CCTP_VERSION_1) {
      url = this._getAttestationUrlV1(cctpMessage, transactionHash);
    } else if (version == this.CCTP_VERSION_2) {
      url = this._getAttestationUrlV2(cctpMessage, transactionHash);
    } else {
      throw new Error(`Unsupported CCTP version: ${version}`);
    }

    const options = {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    const resp = await fetch(url, options);

    if (!resp.ok) {
      throw new Error(`CCTP attestation request failed: ${resp.statusText}`);
    }

    const json: CCTPData = await resp.json();

    return [json.messages[0].message, json.messages[0].attestation];
  }
}

export { CCTPAttestationService };
