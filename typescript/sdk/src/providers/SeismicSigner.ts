import { BigNumber, Signer, providers, utils } from 'ethers';
import {
  createShieldedWalletClient,
  decryptRevertError,
  randomEncryptionNonce,
  signSeismicTxTypedData,
  type TxSeismicMetadata,
} from 'seismic-viem';
import { http, isHex } from 'viem';
import { toAccount } from 'viem/accounts';
import { z } from 'zod';

import { addBufferToGasLimit, assert } from '@hyperlane-xyz/utils';

const SIGNED_READ_BLOCK_WINDOW = 100n;
// Seismic's EIP-712 message version (distinct from raw-transaction signing).
const TYPED_DATA_MESSAGE_VERSION = 2;
const TypedDataFieldsSchema = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), type: z.string() })),
);

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
 * Signed reads require Seismic encryption metadata and a replay-protected
 * signature. The official client handles encryption and EIP-712 encoding;
 * signing delegates to the wrapped signer without exporting its private key.
 *
 * Writes are plain transparent transactions that already work on Seismic, so
 * `sendTransaction` delegates to the wrapped signer. It first fills in a
 * missing `gasLimit` with the signed-read estimate: otherwise the inner
 * signer's `populateTransaction` would run an unsigned `eth_estimateGas`,
 * which Seismic executes with `msg.sender = 0x0` and therefore reverts for
 * every owner-gated call (`setDefaultHook`, `transferOwnership`, ...).
 *
 * `signedCall` is the matching signed `eth_call`, for reads whose result
 * depends on `msg.sender`: shielded tokens only reveal `balanceOf`/`allowance`
 * to the account itself, so the SDK's pre-transfer balance checks need it. It
 * is deliberately not an override of `Signer.call`: ethers routes every view
 * call of a signer-connected Contract through `call`, and turning all of those
 * into encrypted multi-round-trip signed reads is neither needed nor cheap.
 */
export class SeismicSigner extends Signer {
  // Set at runtime via defineReadOnly (ethers pattern); base Signer declares it.
  declare readonly provider?: providers.Provider;

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

  async sendTransaction(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<providers.TransactionResponse> {
    const resolved = await utils.resolveProperties(tx);
    if (resolved.gasLimit !== undefined && resolved.gasLimit !== null) {
      return this.inner.sendTransaction(resolved);
    }
    const estimatedGas = await this.estimateGas(resolved);
    return this.inner.sendTransaction({
      ...resolved,
      gasLimit: addBufferToGasLimit(estimatedGas),
    });
  }

  connect(provider: providers.Provider): SeismicSigner {
    return new SeismicSigner(this.inner.connect(provider), this.context);
  }

  /**
   * Signed-read gas estimation. Sends an encrypted EIP-712 signed read to
   * Seismic's `eth_estimateGas` so it recovers the real `msg.sender`. Fees are
   * zeroed so estimation isn't gated on the signer's balance (it only needs the
   * execution-gas estimate; the actual send uses normal fees).
   */
  async estimateGas(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<BigNumber> {
    const { client, typedData, signature } =
      await this.prepareSignedRequest(tx);
    const gas = await client.request({
      method: 'eth_estimateGas',
      params: [{ data: typedData, signature }],
    });
    return BigNumber.from(gas);
  }

  /**
   * Signed read. Sends an encrypted EIP-712 signed read to Seismic's
   * `eth_call` so the node executes it with the real `msg.sender`, and
   * decrypts the response (and any revert data) with the request's key.
   * Returns the plaintext ABI-encoded return data. Unlike `call`, which stays
   * the inherited unsigned read, callers opt in explicitly. Always reads at
   * `latest`: the request's nonce and replay window are taken from the
   * current chain head, so it cannot meaningfully target another block.
   */
  async signedCall(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<string> {
    const { client, metadata, typedData, signature } =
      await this.prepareSignedRequest(tx);
    let response: unknown;
    try {
      response = await client.request({
        method: 'eth_call',
        params: [{ data: typedData, signature }, 'latest'],
      });
    } catch (error) {
      throw await decryptRevertError(client, error, metadata);
    }
    assert(
      typeof response === 'string' && isHex(response),
      'Invalid Seismic signed-read response',
    );
    return client.decrypt(response, metadata);
  }

  /**
   * Builds the encrypted, EIP-712-signed Seismic request shared by signed
   * estimates and signed reads. Fees are zeroed so the request isn't gated on
   * the signer's balance; gas is the block gas limit.
   */
  private async prepareSignedRequest(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ) {
    const resolved = await utils.resolveProperties(tx);
    const inner = this.inner;
    assert(
      '_signTypedData' in inner && typeof inner._signTypedData === 'function',
      'Seismic gas estimation requires EIP-712 typed-data signing',
    );
    const signTypedData = inner._signTypedData.bind(inner);
    const address = await inner.getAddress();
    assert(isHex(address), 'Invalid Seismic signer address');
    assert(
      resolved.from === undefined ||
        utils.getAddress(resolved.from) === utils.getAddress(address),
      'Seismic transaction from does not match signer',
    );
    assert(
      resolved.chainId === undefined ||
        resolved.chainId === this.context.chainId,
      'Seismic transaction chainId does not match signer context',
    );
    const account = toAccount({
      address,
      signMessage: async () => {
        throw new Error('Seismic gas estimation only signs typed data');
      },
      signTransaction: async () => {
        throw new Error('Seismic gas estimation only signs typed data');
      },
      signTypedData: async ({ domain, types, message }) => {
        const ethersTypes = Object.fromEntries(
          Object.entries(TypedDataFieldsSchema.parse(types)).filter(
            ([name]) => name !== 'EIP712Domain',
          ),
        );
        const signature: unknown = await signTypedData(
          domain,
          ethersTypes,
          message,
        );
        assert(
          typeof signature === 'string' && isHex(signature),
          'Invalid Seismic typed-data signature',
        );
        return signature;
      },
    });
    const client = await createShieldedWalletClient({
      account,
      transport: http(this.context.rpcUrl),
    });
    const [chainId, block, nonce, to] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockTag: 'latest' }),
      resolved.nonce ??
        client.getTransactionCount({ address, blockTag: 'pending' }),
      resolved.to === undefined || utils.isAddress(resolved.to)
        ? resolved.to
        : inner.resolveName(resolved.to),
    ]);
    assert(chainId === this.context.chainId, 'Seismic RPC chainId mismatch');
    assert(
      to === undefined || isHex(to),
      'Invalid Seismic transaction recipient',
    );
    const metadata: TxSeismicMetadata = {
      sender: address,
      legacyFields: {
        chainId,
        nonce: BigNumber.from(nonce).toNumber(),
        to,
        value: BigNumber.from(resolved.value ?? 0).toBigInt(),
      },
      seismicElements: {
        encryptionPubkey: client.getEncryptionPublicKey(),
        encryptionNonce: randomEncryptionNonce(),
        messageVersion: TYPED_DATA_MESSAGE_VERSION,
        recentBlockHash: block.hash,
        expiresAtBlock: block.number + SIGNED_READ_BLOCK_WINDOW,
        signedRead: true,
      },
    };
    const data = utils.hexlify(resolved.data ?? '0x');
    assert(isHex(data), 'Invalid Seismic transaction data');
    const encryptedData = await client.encrypt(data, metadata);
    const { typedData, signature } = await signSeismicTxTypedData(client, {
      type: 'seismic',
      ...metadata.legacyFields,
      to,
      gasPrice: 0n,
      gas: block.gasLimit,
      data: encryptedData,
      ...metadata.seismicElements,
    });
    return { client, metadata, typedData, signature };
  }
}
