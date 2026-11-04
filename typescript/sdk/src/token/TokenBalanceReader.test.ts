import { expect } from 'chai';
import { providers } from 'ethers';
import sinon from 'sinon';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  isHex,
  multicall3Abi,
} from 'viem';
import {
  assert,
  convertToProtocolAddress,
  ProtocolType,
} from '@hyperlane-xyz/utils';
import { test1, test2 } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { Token } from './Token.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenBalanceReader } from './TokenBalanceReader.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const uint = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
function token(
  n: number,
  standard = TokenStandard.EvmHypSynthetic,
  chainName = 'test1',
) {
  return new Token({
    chainName,
    standard,
    addressOrDenom: address(n),
    decimals: 18,
    name: 'Test',
    symbol: 'T',
  });
}
function setup() {
  const provider = new providers.JsonRpcProvider();
  const mp = new MultiProvider({ test1, test2 });
  mp.setProvider('test1', provider);
  const reader = new TokenBalanceReader(
    MultiProtocolProvider.fromMultiProvider(mp),
  );
  const code = sinon.stub(provider, 'getCode').resolves('0x1234');
  const call = sinon.stub(provider, 'call').callsFake(async (tx) => {
    const data = await tx.data;
    assert(isHex(data), 'Expected hex calldata');
    if (data.startsWith('0x82ad56cb')) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      assert(Array.isArray(args[0]), 'Expected aggregate calls');
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: args[0].map(() => ({ success: true, returnData: uint(7n) })),
      });
    }
    return uint(7n);
  });
  return { provider, reader, code, call, mp };
}

describe('TokenBalanceReader', () => {
  afterEach(() => sinon.restore());

  it('uses one outer call for three supply reads and preserves the block tag', async () => {
    const { reader, call, code } = setup();
    expect(
      await Promise.all(
        [1, 2, 3].map((i) => reader.getBridgedSupply(token(i), 100)),
      ),
    ).to.deep.equal([7n, 7n, 7n]);
    expect(call.callCount).to.equal(1);
    expect(call.firstCall.args[1]).to.equal(100);
    expect(code.firstCall.args[1]).to.equal(100);
  });

  it('deduplicates concurrent identical reads but never retains a balance across cycles', async () => {
    const { reader, call } = setup();
    const t = token(1);
    expect(
      await Promise.all([
        reader.getBridgedSupply(t),
        reader.getBridgedSupply(t),
      ]),
    ).to.deep.equal([7n, 7n]);
    expect(call.callCount).to.equal(1);
    call.resolves(uint(8n));
    expect(await reader.getBridgedSupply(t)).to.equal(8n);
    expect(call.callCount).to.equal(2);
  });

  it('does not combine different owners or block tags', async () => {
    const { reader, call } = setup();
    const t = token(1);
    await Promise.all([
      reader.getBalance(t, address(10)),
      reader.getBalance(t, address(11)),
      reader.getBridgedSupply(t, 100),
      reader.getBridgedSupply(t, 101),
    ]);
    expect(call.callCount).to.equal(4);
  });

  it('normalizes a Tron owner before encoding an EVM balance read', async () => {
    const { reader, call } = setup();
    const owner = address(10);
    const tronOwner = convertToProtocolAddress(owner, ProtocolType.Tron);
    expect(await reader.getBalance(token(1), tronOwner)).to.equal(7n);
    const data = await call.firstCall.args[0].data;
    assert(isHex(data), 'Expected balance calldata');
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    expect(decoded.functionName).to.equal('balanceOf');
    assert(decoded.args?.[0], 'Expected owner argument');
    expect(decoded.args[0].toLowerCase()).to.equal(owner);
  });

  it('uses direct calls when the requested block predates Multicall', async () => {
    const { reader, call, code } = setup();
    code.resolves('0x');
    await Promise.all(
      [1, 2, 3].map((i) => reader.getBridgedSupply(token(i), 1)),
    );
    expect(call.callCount).to.equal(3);
    expect(call.args.every((a) => a[1] === 1)).to.equal(true);
  });

  it('isolates reverted subcalls without turning them into zero balances', async () => {
    const { reader, call } = setup();
    call.resolves(
      encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: [
          { success: true, returnData: uint(3n) },
          { success: false, returnData: '0x' },
          { success: true, returnData: uint(5n) },
        ],
      }),
    );
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => reader.getBridgedSupply(token(i))),
    );
    expect(results.map((r) => r.status)).to.deep.equal([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(results[0]).to.deep.equal({ status: 'fulfilled', value: 3n });
    expect(results[2]).to.deep.equal({ status: 'fulfilled', value: 5n });
  });

  it('retries direct token calls after a failed Multicall probe', async () => {
    const { reader, call, code } = setup();
    code.rejects(new Error('RPC unavailable'));
    expect(
      await Promise.all(
        [1, 2, 3].map((i) => reader.getBridgedSupply(token(i))),
      ),
    ).to.deep.equal([7n, 7n, 7n]);
    expect(call.callCount).to.equal(3);
  });

  it('retries a failed aggregate directly and isolates token call errors', async () => {
    const { reader, call } = setup();
    call.callsFake(async (tx) => {
      const data = await tx.data;
      assert(isHex(data), 'Expected calldata');
      if (data.startsWith('0x82ad56cb')) throw new Error('Batch gas limit');
      if (tx.to === address(2)) throw new Error('Token RPC error');
      return uint(7n);
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => reader.getBridgedSupply(token(i))),
    );
    expect(results.map((r) => r.status)).to.deep.equal([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(call.callCount).to.equal(4);
    call.resolves(uint(8n));
    await reader.getBridgedSupply(token(1));
    expect(call.callCount).to.equal(5);
  });

  it('bounds large batches', async () => {
    const { reader, call } = setup();
    await Promise.all(
      Array.from({ length: 129 }, (_, i) =>
        reader.getBridgedSupply(token(i + 1)),
      ),
    );
    expect(call.callCount).to.equal(2);
  });

  it('reuses collateral metadata across five-minute polls and refreshes it after fifteen minutes', async () => {
    const { reader, call } = setup();
    const t = token(1, TokenStandard.EvmHypCollateral);
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    let metadataReads = 0;
    call.callsFake(async (tx) => {
      const data = await tx.data;
      if (data === '0x996c6cc3') {
        // wrappedToken()
        metadataReads++;
        return encodeAbiParameters(
          [{ type: 'address' }],
          ['0x0000000000000000000000000000000000000010'],
        );
      }
      return uint(9n);
    });
    expect(await reader.getBridgedSupply(t)).to.equal(9n);
    expect(await reader.getBalance(t, address(2))).to.equal(9n);
    expect(metadataReads).to.equal(1);
    clock.tick(5 * 60_000);
    expect(await reader.getBridgedSupply(t)).to.equal(9n);
    expect(metadataReads).to.equal(1);
    clock.tick(10 * 60_000);
    expect(await reader.getBridgedSupply(t)).to.equal(9n);
    expect(metadataReads).to.equal(2);
  });

  it('leaves native balances on the existing adapter path', async () => {
    const { reader, provider, call } = setup();
    sinon
      .stub(provider, 'getBalance')
      .resolves(providers.Formatter.prototype.bigNumber('42'));
    expect(
      await reader.getBridgedSupply(token(1, TokenStandard.EvmHypNative), 100),
    ).to.equal(42n);
    expect(call.called).to.equal(false);
  });
});
