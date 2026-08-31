import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import { ProtocolType, fromHexString, strip0x } from '@hyperlane-xyz/utils';

import { RegistryService } from '../../src/services/registryService.js';
import { SignerService } from '../../src/signer/signerService.js';
import type {
  Eip712Payload,
  SignerTransactionRequest,
  TransactionSignerBackend,
} from '../../index.js';
import { mockChainMetadata } from '../utils/mockData.js';

chaiUse(chaiAsPromised);

const CHAIN = mockChainMetadata.name;
const SENTINEL = 'deadbeef'.repeat(32);

class InvalidBackend implements TransactionSignerBackend {
  private readonly wallet = ethers.Wallet.createRandom();

  async getAccount() {
    return { address: this.wallet.address, curve: 'secp256k1' as const };
  }

  async healthCheck() {}

  async signTransaction() {
    return {
      signedTransaction: fromHexString(SENTINEL),
      backendRequestId: 'backend-request',
    };
  }

  async signTypedData() {
    return {
      signature: SENTINEL,
      backendRequestId: 'backend-request',
    };
  }
}

describe('SignerService logging', () => {
  afterEach(() => sinon.restore());

  it('does not log backend-controlled validation payloads', async () => {
    const logger = pino({ level: 'silent' });
    const warn = sinon.spy(logger, 'warn');
    const registry = new PartialRegistry({
      chainMetadata: { [CHAIN]: mockChainMetadata },
      chainAddresses: {},
      warpRoutes: [],
    });
    const registryService = new RegistryService(
      async () => registry,
      1_000,
      logger,
    );
    await registryService.initialize();
    const service = new SignerService(
      registryService,
      { [ProtocolType.Ethereum]: new InvalidBackend() },
      logger,
    );
    const unsignedTransaction = ethers.utils.serializeTransaction({
      type: 2,
      chainId: Number(mockChainMetadata.chainId),
      nonce: 0,
      gasLimit: 21_000,
      maxPriorityFeePerGas: 1,
      maxFeePerGas: 2,
      to: '0x0000000000000000000000000000000000000001',
      value: 0,
      data: '0x',
    });
    const request: SignerTransactionRequest = {
      chain: CHAIN,
      transaction: {
        encoding: 'hex',
        value: strip0x(unsignedTransaction),
      },
    };
    const typedData: Eip712Payload = {
      types: {
        EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
        Mail: [{ name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      domain: { chainId: Number(mockChainMetadata.chainId) },
      message: { contents: 'hello' },
    };

    await expect(service.signTransaction(request)).to.be.rejectedWith(
      'Signing backend returned an invalid transaction',
    );
    await expect(
      service.signTypedData({ chain: CHAIN, typedData }),
    ).to.be.rejectedWith(
      'Signing backend returned an invalid typed-data signature',
    );

    expect(warn.callCount).to.equal(2);
    for (const call of warn.getCalls()) {
      expect(call.firstArg).not.to.have.property('err');
      expect(JSON.stringify(call.args)).not.to.include(SENTINEL);
      expect(call.firstArg.validationErrorType).to.equal('Error');
    }
    expect(
      warn.getCalls().map((call) => call.firstArg.validationErrorCode),
    ).to.deep.equal(['BUFFER_OVERRUN', 'INVALID_ARGUMENT']);
  });
});
