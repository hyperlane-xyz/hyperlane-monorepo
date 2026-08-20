import { expect } from 'chai';
import { BigNumber, Wallet, providers } from 'ethers';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sinon from 'sinon';

import {
  EV5JsonRpcSubmissionError,
  EV5JsonRpcTxSubmitter,
  MultiProvider,
  testChainMetadata,
  testSealevelChain,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../utils/files.js';

import {
  prepareExternalSubmission,
  runExternalSubmit,
  validateExternalTransactions,
} from './submit.js';

describe('external submission', () => {
  const tempDirs: string[] = [];
  const signer = Wallet.createRandom();
  const tx = {
    chainId: Number(testChainMetadata.test1.chainId),
    from: signer.address,
    to: Wallet.createRandom().address,
    data: '0x12345678',
  };

  let multiProvider: MultiProvider;
  let provider: providers.JsonRpcProvider;
  let getBalance: sinon.SinonStub;
  let getFeeData: sinon.SinonStub;
  let estimateGas: sinon.SinonStub;

  beforeEach(() => {
    provider = new providers.JsonRpcProvider('http://127.0.0.1:8545');
    multiProvider = MultiProvider.createTestMultiProvider({ provider });
    getFeeData = sinon.stub(provider, 'getFeeData').resolves({
      gasPrice: BigNumber.from(2),
      maxFeePerGas: BigNumber.from(3),
      maxPriorityFeePerGas: BigNumber.from(1),
      lastBaseFeePerGas: BigNumber.from(1),
    });
    getBalance = sinon
      .stub(provider, 'getBalance')
      .resolves(BigNumber.from(1_000_000));
    estimateGas = sinon
      .stub(multiProvider, 'estimateGas')
      .resolves(BigNumber.from(21_000));
  });

  afterEach(() => {
    sinon.restore();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
  });

  describe('prepareExternalSubmission', () => {
    it('preflights an EVM transaction with EIP-1559 fees', async () => {
      const plans = await prepareExternalSubmission({
        context: { multiProvider },
        signer,
        transactions: [tx],
      });

      expect(plans).to.have.length(1);
      expect(plans[0].chain).to.equal('test1');
      expect(plans[0].requiredBalance.eq(63_000)).to.equal(true);
    });

    it('budgets the declared gas limit and fee cap', async () => {
      const plans = await prepareExternalSubmission({
        context: { multiProvider },
        signer,
        transactions: [
          {
            ...tx,
            gasLimit: BigNumber.from(30_000),
            maxFeePerGas: BigNumber.from(5),
          },
        ],
      });

      expect(plans[0].requiredBalance.eq(150_000)).to.equal(true);
    });

    it('validates the complete input before making RPC requests', async () => {
      let error: Error | undefined;
      try {
        await prepareExternalSubmission({
          context: { multiProvider },
          signer,
          transactions: [tx, { ...tx, from: Wallet.createRandom().address }],
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include('does not match external signer');
      expect(getFeeData.called).to.equal(false);
    });

    it('rejects non-Ethereum transactions', async () => {
      const nonEvmMultiProvider = new MultiProvider({
        ...testChainMetadata,
        [testSealevelChain.name]: testSealevelChain,
      });

      let error: Error | undefined;
      try {
        await prepareExternalSubmission({
          context: { multiProvider: nonEvmMultiProvider },
          signer,
          transactions: [{ ...tx, chainId: Number(testSealevelChain.chainId) }],
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include(
        'External EVM signers cannot submit transactions',
      );
    });

    it('rejects an insufficient signer balance', async () => {
      getBalance.resolves(BigNumber.from(1));

      let error: Error | undefined;
      try {
        await prepareExternalSubmission({
          context: { multiProvider },
          signer,
          transactions: [tx],
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include('insufficient balance');
    });
  });

  describe('runExternalSubmit', () => {
    it('rejects transactions that do not estimate independently', async () => {
      estimateGas
        .onFirstCall()
        .resolves(BigNumber.from(21_000))
        .onSecondCall()
        .rejects(new Error('execution reverted'));
      const submit = sinon.stub(EV5JsonRpcTxSubmitter.prototype, 'submit');
      const receiptsPath = mkdtempSync(
        join(tmpdir(), 'hyperlane-external-receipts-'),
      );
      tempDirs.push(receiptsPath);

      let error: Error | undefined;
      try {
        await runExternalSubmit({
          context: { multiProvider, skipConfirmation: true },
          signer,
          transactions: [tx, tx],
          receiptsFilepath: receiptsPath,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include(
        'Transaction 2 on test1 cannot be estimated independently',
      );
      expect(error?.message).to.include(
        'Split state-dependent transactions into separate submit runs',
      );
      expect(submit.called).to.equal(false);
    });

    it('validates the complete external batch before submission', async () => {
      const submit = sinon.stub(EV5JsonRpcTxSubmitter.prototype, 'submit');
      const receiptsPath = mkdtempSync(
        join(tmpdir(), 'hyperlane-external-receipts-'),
      );
      tempDirs.push(receiptsPath);

      let error: Error | undefined;
      try {
        await runExternalSubmit({
          context: { multiProvider, skipConfirmation: true },
          signer,
          transactions: [
            tx,
            {
              ...tx,
              maxFeePerGas: { _isBigNumber: true, _hex: '-0x01' },
            },
          ],
          receiptsFilepath: receiptsPath,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include('Invalid');
      expect(submit.called).to.equal(false);
      expect(getFeeData.called).to.equal(false);
    });

    it('writes partial submission progress before rethrowing', async () => {
      // CAST: minimal ethers receipt fixture; serialization is the behavior under test.
      const receipt = {
        transactionHash: '0x01',
        status: 1,
      } as providers.TransactionReceipt;
      sinon
        .stub(EV5JsonRpcTxSubmitter.prototype, 'submit')
        .rejects(
          new EV5JsonRpcSubmissionError(
            'confirmation timeout',
            [{ transactionHash: '0x01', receipt }, { transactionHash: '0x02' }],
            new Error('confirmation timeout'),
          ),
        );
      const receiptsPath = mkdtempSync(
        join(tmpdir(), 'hyperlane-external-receipts-'),
      );
      tempDirs.push(receiptsPath);

      let error: Error | undefined;
      try {
        await runExternalSubmit({
          context: { multiProvider, skipConfirmation: true },
          signer,
          transactions: [tx],
          receiptsFilepath: receiptsPath,
        });
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }

      expect(error?.message).to.include('confirmation timeout');
      const files = readdirSync(receiptsPath);
      expect(files).to.have.length(1);
      expect(files[0]).to.include('jsonRpc-partial');
      expect(readYamlOrJson(join(receiptsPath, files[0]))).to.deep.equal([
        { transactionHash: '0x01', receipt },
        { transactionHash: '0x02' },
      ]);
    });
  });

  describe('validateExternalTransactions', () => {
    it('normalizes supported numeric and access-list fields', () => {
      const [validated] = validateExternalTransactions([
        {
          ...tx,
          accessList: {
            [Wallet.createRandom().address]: [`0x${'00'.repeat(32)}`],
          },
          gasLimit: '0x5208',
          maxFeePerGas: '3',
          maxPriorityFeePerGas: 1,
          type: 2,
          value: '0',
        },
      ]);

      expect(BigNumber.isBigNumber(validated.gasLimit)).to.equal(true);
      expect(validated.gasLimit?.toString()).to.equal('21000');
      expect(validated.accessList).to.have.length(1);
    });

    it('rejects unsupported transaction fields', () => {
      expect(() =>
        validateExternalTransactions([{ ...tx, ccipReadEnabled: true }]),
      ).to.throw('Unrecognized key');
    });

    it('rejects incompatible fee fields', () => {
      expect(() =>
        validateExternalTransactions([{ ...tx, gasPrice: 1, maxFeePerGas: 2 }]),
      ).to.throw('gasPrice cannot be combined');
    });

    it('rejects negative serialized values', () => {
      expect(() =>
        validateExternalTransactions([{ ...tx, maxFeePerGas: '-1' }]),
      ).to.throw('Invalid');
    });
  });
});
