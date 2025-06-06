import { BytesLike, ethers } from 'ethers';

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

  /**
   * Get the CCTP v2 attestation
   * @param CCTP message retrieved from the MessageSend log event
   * @param transaction hash containing the MessageSent event
   * @returns the attestation byte array
   */
  async getAttestation(cctpMessage: string, transactionHash: string) {
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
