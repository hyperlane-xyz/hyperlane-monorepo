import { BigNumber, Signer, providers, utils } from 'ethers';
import {
  createShieldedWalletClient,
  randomEncryptionNonce,
  signSeismicTxTypedData,
  type TxSeismicMetadata,
} from 'seismic-viem';
import { http, isHex } from 'viem';
import { toAccount } from 'viem/accounts';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

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
 * Only `estimateGas` is overridden. Writes are plain transparent transactions
 * that already work on Seismic, so everything else delegates to the wrapped
 * signer.
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

  sendTransaction(
    tx: utils.Deferrable<providers.TransactionRequest>,
  ): Promise<providers.TransactionResponse> {
    return this.inner.sendTransaction(tx);
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
    const gas = await client.request({
      method: 'eth_estimateGas',
      params: [{ data: typedData, signature }],
    });
    return BigNumber.from(gas);
  }
}
