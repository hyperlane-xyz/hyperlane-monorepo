import { expect } from 'chai';
import { CallData } from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  callContract,
  extractEnumVariant,
  getFeeTokenAddress,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
  toNumber,
} from './contracts.js';

describe('starknet-sdk contracts helpers', () => {
  it('normalizes zeroish addresses to 32-byte zero address', () => {
    expect(normalizeStarknetAddressSafe('0x0')).to.equal(ZERO_ADDRESS_HEX_32);
  });

  it('uses native denom as fee token when provided', () => {
    const nativeDenom = '0x1234';
    expect(
      getFeeTokenAddress({ chainName: 'starknetsepolia', nativeDenom }),
    ).to.equal(
      '0x0000000000000000000000000000000000000000000000000000000000001234',
    );
  });

  it('falls back to known fee token by chain name', () => {
    expect(getFeeTokenAddress({ chainName: 'starknetsepolia' })).to.equal(
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    );
  });

  it('extracts enum variant key from starknet-like object', () => {
    expect(extractEnumVariant({ MERKLE_TREE: {} })).to.equal('MERKLE_TREE');
  });

  it('preserves single-key enum variants with undefined payloads', () => {
    expect(extractEnumVariant({ NOOP: undefined })).to.equal('NOOP');
    expect(extractEnumVariant({ NOOP: null })).to.equal('NOOP');
  });

  it('preserves zero-like enum values instead of treating them as empty', () => {
    expect(extractEnumVariant(0)).to.equal('0');
    expect(extractEnumVariant(0n)).to.equal('0');
    expect(extractEnumVariant({ MERKLE_TREE: 0 })).to.equal('MERKLE_TREE');
  });

  it('preserves contract context in callContract fallback path', async () => {
    const contract = {
      address: '0x1234',
      abi: [{ type: 'function', name: 'balance_of' }],
      call(this: { address: string }, method: string, args: unknown[]) {
        return `${this.address}:${method}:${args.length}`;
      },
    };

    const result = await callContract(contract as never, 'balance_of', ['0x1']);
    expect(result).to.equal('0x1234:balance_of:1');
  });

  it('compiles calldata when populateTransaction helper is unavailable', async () => {
    const { abi } = getCompiledContract(
      StarknetContractName.HYP_ERC20,
      ContractType.TOKEN,
    );
    const contract = {
      address: '0x1234',
      abi,
    };

    const tx = await populateInvokeTx(contract as never, 'owner');

    expect(tx.kind).to.equal('invoke');
    expect(tx.contractAddress).to.equal(
      '0x0000000000000000000000000000000000000000000000000000000000001234',
    );
    expect(tx.entrypoint).to.equal('owner');
    expect(tx.calldata).to.deep.equal(new CallData(abi).compile('owner', []));
  });

  it('throws when coercing bigint values above the safe integer range', () => {
    expect(() => toNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).to.throw(
      /safe integer/i,
    );
  });
});
