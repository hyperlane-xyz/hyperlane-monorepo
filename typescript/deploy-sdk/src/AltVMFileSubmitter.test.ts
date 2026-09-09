import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';

import { ProtocolType, SubmitterType } from '@hyperlane-xyz/provider-sdk';
import { SealevelSigner } from '@hyperlane-xyz/sealevel-sdk';

import { AltVMFileSubmitter } from './AltVMFileSubmitter.js';

describe('AltVMFileSubmitter', () => {
  it('exports unstamped Sealevel governance as v0 on a v1-default chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'svm-file-submitter-'));
    try {
      const signer = await SealevelSigner.connectWithSigner(
        {
          name: 'local',
          chainId: 1,
          domainId: 1,
          protocol: ProtocolType.Sealevel,
          rpcUrls: [{ http: 'http://127.0.0.1:1' }],
          maxSupportedTransactionVersion: 1,
          sealevelTransactionVersion: 1,
          sealevelV1TransactionsEnabled: true,
        },
        '01'.repeat(32),
      );
      const filepath = join(directory, 'transactions.json');
      const submitter = new AltVMFileSubmitter(signer, {
        type: SubmitterType.File,
        chain: 'local',
        filepath,
      });
      const transaction = {
        instructions: [],
        heapSize: 256 * 1024,
        loadedAccountsDataSizeLimit: 128 * 1024,
      };
      await submitter.submit(transaction);
      const expected = await signer.transactionToPrintableJson({
        ...transaction,
        version: 0,
      });
      expect(JSON.parse(await readFile(filepath, 'utf8'))).to.deep.equal(
        JSON.parse(JSON.stringify([expected])),
      );
      expect(expected.instructions).to.have.length(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
