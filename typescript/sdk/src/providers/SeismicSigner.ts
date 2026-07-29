import { BigNumber, Signer, providers, utils } from 'ethers';

/**
 * Mirrors seismic-viem's DEFAULT_SIGNED_ESTIMATE_GAS_LIMIT: the gas cap used
 * when signing the throwaway tx we hand to eth_estimateGas.
 */
const DEFAULT_SIGNED_ESTIMATE_GAS_LIMIT = BigNumber.from(30_000_000);

/**
 * Context needed to issue a signed read against a Seismic chain.
 */
export interface SeismicSignerContext {
  chainId: number;
  rpcUrl: string;
  name: string;
}

/**
 * Wraps an ethers Signer for Seismic chains.
 *
 * On Seismic, unsigned `eth_call`/`eth_estimateGas` zero out the `from` field
 * (msg.sender = 0x0) to protect access-controlled shielded state. Gas estimation
 * for owner-gated calls therefore reverts with "Ownable: caller is not the
 * owner". Seismic's `eth_estimateGas` instead accepts a *signed* raw transaction
 * and recovers `msg.sender` from the signature (a "signed read").
 *
 * This is exactly what seismic-viem's transparent send path does for local
 * accounts: it signs a standard tx and calls `eth_estimateGas` with the raw
 * hex rather than a call object. Since that requires the caller's key, the
 * override lives on the signer (which holds the key), not the provider.
 *
 * Only `estimateGas` is overridden. Writes are plain transparent transactions
 * that already work on Seismic, so everything else delegates to the wrapped
 * signer.
 */
export class SeismicSigner extends Signer {
  // Set at runtime via defineReadOnly (ethers pattern); base Signer declares it.
  declare readonly provider?: providers.Provider;
  private rawProviderInstance?: providers.JsonRpcProvider;

  constructor(
    public readonly inner: Signer,
    private readonly context: SeismicSignerContext,
  ) {
    super();
    utils.defineReadOnly(this, 'provider', inner.provider);
  }

  static is(signer: Signer): signer is SeismicSigner {
    return signer instanceof SeismicSigner;
  }

  getAddress(): Promise<string> {
    return this.inner.getAddress();
  }

  signMessage(message: string | utils.Bytes): Promise<string> {
    return this.inner.signMessage(message);
  }

  signTransaction(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<string> {
    return this.inner.signTransaction(tx);
  }

  sendTransaction(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<providers.TransactionResponse> {
    return this.inner.sendTransaction(tx);
  }

  connect(provider: providers.Provider): SeismicSigner {
    return new SeismicSigner(this.inner.connect(provider), this.context);
  }

  /**
   * Signed-read gas estimation. Signs the populated tx and hands the raw hex to
   * Seismic's `eth_estimateGas` so it recovers the real `msg.sender`. Fees are
   * zeroed so estimation isn't gated on the signer's balance (it only needs the
   * execution-gas estimate; the actual send uses normal fees).
   */
  async estimateGas(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<BigNumber> {
    const resolved = await utils.resolveProperties(tx);
    const populated = await this.inner.populateTransaction({
      to: resolved.to,
      data: resolved.data,
      value: resolved.value,
      nonce: resolved.nonce,
      type: 2,
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      gasLimit: DEFAULT_SIGNED_ESTIMATE_GAS_LIMIT,
    });
    // ethers Wallet.signTransaction rejects a populated `from`.
    delete populated.from;
    const signedTx = await this.inner.signTransaction(populated);
    const gas: string = await this.rawProvider().send('eth_estimateGas', [
      signedTx,
    ]);
    return BigNumber.from(gas);
  }

  /**
   * A plain JsonRpcProvider for the raw `eth_estimateGas` call. The wrapped
   * provider (HyperlaneSmartProvider) formats estimateGas as a call object,
   * which is precisely the unsigned path we need to bypass.
   */
  private rawProvider(): providers.JsonRpcProvider {
    this.rawProviderInstance ??= new providers.JsonRpcProvider(
      this.context.rpcUrl,
      this.context.chainId,
    );
    return this.rawProviderInstance;
  }
}
