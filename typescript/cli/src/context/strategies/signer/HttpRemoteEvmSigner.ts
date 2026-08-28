import { ethers } from 'ethers';

import {
  ProtocolType,
  assert,
  ensure0x,
  eqAddressEvm,
} from '@hyperlane-xyz/utils';

import type { HttpSignerClient } from './HttpSignerClient.js';

type SerializableTransaction = {
  type?: number | null;
  chainId?: ethers.BigNumberish;
  nonce?: ethers.BigNumberish;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish | null;
  maxFeePerGas?: ethers.BigNumberish | null;
  maxPriorityFeePerGas?: ethers.BigNumberish | null;
  to?: string | null;
  value?: ethers.BigNumberish;
  data?: ethers.BytesLike;
  accessList?: ethers.utils.AccessListish | null;
};

function toUnsignedTransaction(
  transaction: SerializableTransaction,
): ethers.utils.UnsignedTransaction {
  const commonFields = {
    chainId:
      transaction.chainId == null
        ? undefined
        : ethers.BigNumber.from(transaction.chainId).toNumber(),
    nonce:
      transaction.nonce == null
        ? undefined
        : ethers.BigNumber.from(transaction.nonce).toNumber(),
    gasLimit: transaction.gasLimit,
    to: transaction.to ?? undefined,
    value: transaction.value,
    data: transaction.data,
  };
  switch (transaction.type ?? 0) {
    case 0:
      return {
        ...commonFields,
        type: transaction.type ?? undefined,
        gasPrice: transaction.gasPrice ?? undefined,
      };
    case 1:
      return {
        ...commonFields,
        type: 1,
        gasPrice: transaction.gasPrice ?? undefined,
        accessList: transaction.accessList ?? undefined,
      };
    case 2:
      return {
        ...commonFields,
        type: 2,
        maxFeePerGas: transaction.maxFeePerGas ?? undefined,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? undefined,
        accessList: transaction.accessList ?? undefined,
      };
    default:
      throw new Error(`Unsupported EVM transaction type ${transaction.type}`);
  }
}

export class HttpRemoteEvmSigner extends ethers.Signer {
  declare readonly provider?: ethers.providers.Provider;

  private constructor(
    private readonly client: HttpSignerClient,
    private readonly chain: string,
    private readonly address: string,
    provider?: ethers.providers.Provider,
  ) {
    super();
    ethers.utils.defineReadOnly(this, 'provider', provider);
  }

  static async create(
    client: HttpSignerClient,
    chain: string,
    provider?: ethers.providers.Provider,
  ): Promise<HttpRemoteEvmSigner> {
    const account = await client.getAccount(chain);
    assert(
      account.chain === chain,
      `HTTP signer returned account for ${account.chain}, expected ${chain}`,
    );
    assert(
      account.protocol === ProtocolType.Ethereum,
      `HTTP signer account for ${chain} uses unsupported protocol ${account.protocol}`,
    );
    assert(
      account.curve === 'secp256k1',
      `HTTP signer account for ${chain} uses unsupported curve ${account.curve}`,
    );

    return new HttpRemoteEvmSigner(
      client,
      chain,
      ethers.utils.getAddress(account.address),
      provider,
    );
  }

  connect(provider: ethers.providers.Provider): HttpRemoteEvmSigner {
    return new HttpRemoteEvmSigner(
      this.client,
      this.chain,
      this.address,
      provider,
    );
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async signTransaction(
    transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
  ): Promise<string> {
    const resolved = await ethers.utils.resolveProperties(transaction);
    if (resolved.from != null) {
      assert(
        eqAddressEvm(resolved.from, this.address),
        `Transaction from ${resolved.from} does not match HTTP signer ${this.address}`,
      );
    }

    const unsignedFields = toUnsignedTransaction(resolved);
    const unsignedTransaction =
      ethers.utils.serializeTransaction(unsignedFields);
    const response = await this.client.signTransaction(
      this.chain,
      unsignedTransaction,
    );
    assert(
      response.chain === this.chain,
      `HTTP signer returned transaction for ${response.chain}, expected ${this.chain}`,
    );
    assert(
      eqAddressEvm(response.signerAddress, this.address),
      `HTTP signer returned transaction for ${response.signerAddress}, expected ${this.address}`,
    );
    assert(
      response.signedTransaction.encoding === 'hex',
      'HTTP signer returned a non-hex Ethereum transaction',
    );

    const signedTransaction = ensure0x(response.signedTransaction.value);
    const parsed = ethers.utils.parseTransaction(signedTransaction);
    const returnedUnsignedTransaction = ethers.utils.serializeTransaction(
      toUnsignedTransaction(parsed),
    );
    assert(
      returnedUnsignedTransaction === unsignedTransaction,
      'HTTP signer modified the Ethereum transaction payload',
    );
    assert(
      parsed.from != null && eqAddressEvm(parsed.from, this.address),
      `HTTP signer returned a transaction signed by ${parsed.from}, expected ${this.address}`,
    );

    return signedTransaction;
  }

  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const populated = await ethers.utils._TypedDataEncoder.resolveNames(
      domain,
      types,
      value,
      async (name: string) => {
        if (!this.provider) {
          throw new Error(
            `Cannot resolve ENS name "${name}" without a provider`,
          );
        }
        const address = await this.provider.resolveName(name);
        assert(address, `Unconfigured ENS name "${name}"`);
        return address;
      },
    );
    const payload = ethers.utils._TypedDataEncoder.getPayload(
      populated.domain,
      types,
      populated.value,
    );
    const response = await this.client.signTypedData(this.chain, payload);
    assert(
      response.chain === this.chain,
      `HTTP signer returned signature for ${response.chain}, expected ${this.chain}`,
    );
    assert(
      eqAddressEvm(response.signerAddress, this.address),
      `HTTP signer returned signature for ${response.signerAddress}, expected ${this.address}`,
    );
    assert(
      eqAddressEvm(
        ethers.utils.verifyTypedData(
          populated.domain,
          types,
          populated.value,
          response.signature,
        ),
        this.address,
      ),
      'HTTP signer returned a typed-data signature from the wrong account',
    );
    return response.signature;
  }

  async signMessage(_message: string | ethers.utils.Bytes): Promise<string> {
    throw new Error('Personal message signing is not supported by HTTP signer');
  }
}
