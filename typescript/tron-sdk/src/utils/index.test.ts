import { expect } from 'chai';
import { ethers } from 'ethers';
import { TronWeb } from 'tronweb';

import { strip0x } from '@hyperlane-xyz/utils';

import { TronReceiptResult, assertTronReceiptSuccess } from './index.js';

const TXID = 'abc123';
// Offline instance: only toUtf8 / abi decoding are exercised, no network calls.
const tronweb = new TronWeb({ fullHost: 'http://127.0.0.1:9090' });

// Standard Solidity Error(string) revert payload: 08c379a0 selector + abi("boom").
const ERROR_STRING_REVERT_DATA =
  '08c379a0' +
  strip0x(ethers.utils.defaultAbiCoder.encode(['string'], ['boom']));

function makeReceipt(fields: {
  result: string;
  resMessage?: string;
  contractResult?: string[];
}): TronReceiptResult {
  return {
    receipt: {
      energy_usage: 0,
      energy_fee: 0,
      origin_energy_usage: 0,
      energy_usage_total: 0,
      net_usage: 0,
      net_fee: 0,
      result: fields.result,
      energy_penalty_total: 0,
    },
    resMessage: fields.resMessage ?? '',
    contractResult: fields.contractResult ?? [],
  };
}

interface Case {
  name: string;
  receipt: TronReceiptResult;
  expectedError?: RegExp;
}

const cases: Case[] = [
  {
    name: 'throws on REVERT and decodes resMessage',
    receipt: makeReceipt({
      result: 'REVERT',
      resMessage: tronweb.fromUtf8('out of energy'),
    }),
    expectedError: /Tron Transaction Failed: out of energy \(txid: abc123\)/,
  },
  {
    name: 'throws on FAILED with a decoded contractResult reason',
    receipt: makeReceipt({
      result: 'FAILED',
      contractResult: [ERROR_STRING_REVERT_DATA],
    }),
    expectedError: /Tron Transaction Failed: boom \(txid: abc123\)/,
  },
  {
    name: 'throws on REVERT with unknown reason when no data present',
    receipt: makeReceipt({ result: 'REVERT' }),
    expectedError: /Tron Transaction Failed: Unknown Error \(txid: abc123\)/,
  },
  {
    name: 'does not throw on SUCCESS',
    receipt: makeReceipt({ result: 'SUCCESS' }),
  },
  {
    name: 'does not throw while pending',
    receipt: makeReceipt({ result: 'PENDING' }),
  },
];

describe('assertTronReceiptSuccess', () => {
  for (const c of cases) {
    it(c.name, () => {
      if (c.expectedError) {
        expect(() =>
          assertTronReceiptSuccess(c.receipt, tronweb, TXID),
        ).to.throw(c.expectedError);
      } else {
        expect(() =>
          assertTronReceiptSuccess(c.receipt, tronweb, TXID),
        ).to.not.throw();
      }
    });
  }
});
