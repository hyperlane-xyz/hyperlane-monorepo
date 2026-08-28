import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';
import { rmSync } from 'node:fs';
import { $ } from 'zx';

import {
  HttpServer,
  type TransactionSignerBackend,
} from '@hyperlane-xyz/http-registry-server';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import { localTestRunCmdPrefix } from './commands/helpers.js';

import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from './consts.js';

const TOKEN = 'ab'.repeat(32);

class LocalWalletSignerBackend implements TransactionSignerBackend {
  constructor(private readonly wallet: Wallet) {}

  async getAccount() {
    return { address: this.wallet.address, curve: 'secp256k1' as const };
  }

  async healthCheck(): Promise<void> {}

  async signTransaction(
    protocol: ProtocolType,
    unsignedTransaction: Uint8Array,
  ) {
    assert(protocol === ProtocolType.Ethereum, 'Expected Ethereum transaction');
    const parsed = ethers.utils.parseTransaction(unsignedTransaction);
    const transaction: ethers.providers.TransactionRequest = {
      type: parsed.type ?? undefined,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      gasPrice: parsed.gasPrice,
      maxFeePerGas: parsed.maxFeePerGas,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
      to: parsed.to ?? undefined,
      value: parsed.value,
      data: parsed.data,
      accessList: parsed.accessList,
    };
    const signedTransaction = await this.wallet.signTransaction(transaction);
    return {
      signedTransaction: ethers.utils.arrayify(signedTransaction),
    };
  }
}

describe('HTTP signer Anvil e2e', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let server: HttpServer;
  const previousToken = process.env.HYP_HTTP_SIGNER_TOKEN;
  const transactionsPath = `${TEMP_PATH}/http-signer-transactions.json`;
  const receiptsPath = `${TEMP_PATH}/http-signer-receipts`;

  afterEach(async () => {
    await server?.stop();
    rmSync(transactionsPath, { force: true });
    rmSync(receiptsPath, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.HYP_HTTP_SIGNER_TOKEN;
    else process.env.HYP_HTTP_SIGNER_TOKEN = previousToken;
  });

  it('populates, remotely signs, broadcasts, and confirms a real transaction', async () => {
    process.env.HYP_HTTP_SIGNER_TOKEN = TOKEN;
    const registry = new FileSystemRegistry({ uri: REGISTRY_PATH });
    const metadata = await registry.getMetadata();
    const backend = new LocalWalletSignerBackend(new Wallet(ANVIL_KEY));
    server = await HttpServer.create(async () => registry, {
      signerToken: TOKEN,
      signers: { [ProtocolType.Ethereum]: backend },
    });
    const listener = await server.start('0');
    const address = listener.address();
    assert(
      typeof address === 'object' && address !== null,
      'Expected signer server TCP address',
    );
    const port = address.port;
    const signerUrl = `http://127.0.0.1:${port}`;

    const recipient = Wallet.createRandom().address;
    const provider = new ethers.providers.JsonRpcProvider(
      metadata[CHAIN_NAME_2].rpcUrls[0].http,
    );
    const value = ethers.BigNumber.from(12_345);
    const balanceBefore = await provider.getBalance(recipient);
    writeYamlOrJson(
      transactionsPath,
      [
        {
          chainId: metadata[CHAIN_NAME_2].chainId,
          to: recipient,
          value: value.toString(),
          data: '0x',
        },
      ],
      'json',
    );

    const result = await $`${localTestRunCmdPrefix()} hyperlane submit \
      --registry ${signerUrl} \
      --transactions ${transactionsPath} \
      --receipts ${receiptsPath} \
      --key ${signerUrl} \
      --verbosity debug \
      --yes`;

    expect(result.exitCode).to.equal(0);
    expect(result.stdout).to.include('Submission complete');
    expect(
      (await provider.getBalance(recipient)).eq(balanceBefore.add(value)),
    ).to.equal(true);
  });
});
