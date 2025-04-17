interface CCTPDataV1 {
  attestation: string;
}

class CCTPAttestationService {
  url: string;
  constructor(url: string) {
    this.url = url;
  }

  /**
   * Request the CCTP attestation from the api
   * @param message hash
   * @returns
   */
  async getAttestationV1(messageHash: string): Promise<string> {
    const url = `${this.url}/v1/attestations/${messageHash}`;
    console.log('url', url);
    const options = {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    const resp = await fetch(url, options);

    if (!resp.ok) {
      throw new Error(`CCTP attestation request failed: ${resp.statusText}`);
    }

    const json: CCTPDataV1 = await resp.json();

    return json.attestation;
  }

  // TODO: remove
  // async getAttestationV1ByTransactionHash(
  //   sourceDomain: number,
  //   txHash: string,
  // ): Promise<string> {
  //   const url = `${this.url}/v1/messages/${sourceDomain}/${txHash}`;
  //   const options = {
  //     method: 'GET',
  //     headers: { 'Content-Type': 'application/json' },
  //   };
  //   const resp = await fetch(url, options);
  //   if (!resp.ok) {
  //     throw new Error(`CCTP attestation request failed: ${resp.statusText}`);
  //   }
  //   const json: ApiResult<CCTPDataV1> = await resp.json();

  //   console.log('json', json);
  //   const status = json.data.status;
  //   if (status === Status.PENDING)
  //     throw new Error(`CCTP attestation not ready`);
  //   if (status !== Status.COMPLETE)
  //     throw new Error(`Unhandled CCTP attestation status: ${status}`);
  //   return json.data.attestation;
  // }
}

export { CCTPAttestationService };
