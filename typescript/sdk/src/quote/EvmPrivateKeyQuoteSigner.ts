import { Wallet, utils as ethersUtils } from 'ethers';

import {
  QuoteSignature,
  RawQuoteSigner,
  SignableInput,
} from '@hyperlane-xyz/provider-sdk/quote';

import { parseEip712Signable } from './Eip712Signable.js';

/**
 * Default `RawQuoteSigner` implementation for EVM. Wraps an ethers `Wallet`
 * and narrows the opaque `SignableInput` envelope to an EIP-712 typed-data
 * payload via `parseEip712Signable`. Throws when the input is not an EIP-712
 * envelope — the SVM digest-style signer is a parallel implementation, not a
 * fallback path here.
 */
export class EvmPrivateKeyQuoteSigner implements RawQuoteSigner {
  private readonly wallet: Wallet;

  constructor(privateKey: string) {
    this.wallet = new Wallet(privateKey);
  }

  async address(): Promise<string> {
    return this.wallet.address;
  }

  async sign(input: SignableInput): Promise<QuoteSignature> {
    const signable = parseEip712Signable(input);
    const sig = await this.wallet._signTypedData(
      signable.domain,
      signable.types,
      signable.message,
    );
    return { signature: ethersUtils.arrayify(sig) };
  }
}
