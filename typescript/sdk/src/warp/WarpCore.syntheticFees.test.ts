import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import sinon from 'sinon';

import { ProtocolType, convertToProtocolAddress } from '@hyperlane-xyz/utils';

import { test1, test2 } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';
import { Token } from '../token/Token.js';
import { TokenStandard } from '../token/TokenStandard.js';
import { EvmHypSyntheticAdapter } from '../token/adapters/EvmTokenAdapter.js';

import { WarpCore } from './WarpCore.js';
import { WarpTxCategory } from './types.js';

describe('WarpCore synthetic token-IGP approvals', () => {
  const ROUTER = '0x0000000000000000000000000000000000000111';
  const SENDER = '0x0000000000000000000000000000000000000222';
  const WRAPPER = '0x0000000000000000000000000000000000000333';
  const AMOUNT = 786_625n;
  const IGP = 213_375n;
  const WARP_FEE = 7_000n;
  const APPROVAL_AMOUNT = AMOUNT + IGP + WARP_FEE;
  const abi = new utils.Interface([
    'function PACKAGE_VERSION() view returns (string)',
    'function hook() view returns (address)',
    'function feeHook() view returns (address)',
    'function allowance(address,address) view returns (uint256)',
    'function quoteTransferRemote(uint32,bytes32,uint256) view returns (tuple(address token,uint256 amount)[])',
    'function approve(address,uint256) returns (bool)',
    'function transferRemote(uint32,bytes32,uint256) payable returns (bytes32)',
  ]);
  let sandbox: sinon.SinonSandbox;
  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });
  afterEach(() => sandbox.restore());

  async function transfer({
    allowance = 0n,
    tokenIgp = IGP,
    nativeIgp = 0n,
    standard = TokenStandard.EvmHypSynthetic,
    predicate = false,
    pinned = true,
    failQuote = false,
    failFeeHook = false,
    missingFeeHook = false,
    contractVersion = '11.0.0',
  } = {}) {
    const multiProvider = new MultiProtocolProvider({
      [test1.name]: {
        ...test1,
        protocol: standard.startsWith('Tron')
          ? ProtocolType.Tron
          : ProtocolType.Ethereum,
      },
      [test2.name]: test2,
    });
    const token = new Token({
      chainName: test1.name,
      standard,
      addressOrDenom: standard.startsWith('Tron')
        ? convertToProtocolAddress(ROUTER, ProtocolType.Tron)
        : ROUTER,
      decimals: 6,
      symbol: 'TEST',
      name: 'Test synthetic',
    });
    const allowanceRead = sandbox.stub().returns(allowance);
    const feeHookRead = sandbox.spy();
    // Keep real WarpCore, adapter decisions and calldata builders. Only RPC
    // reads are supplied here, including fee-hook configuration and allowances.
    sandbox
      .stub(multiProvider.getEthersV5Provider(test1.name), 'call')
      .callsFake(async (tx) => {
        if (typeof tx.data !== 'string')
          throw new Error('Missing contract calldata');
        const { name, args } = abi.parseTransaction({ data: tx.data });
        switch (name) {
          case 'PACKAGE_VERSION':
            return abi.encodeFunctionResult(name, [contractVersion]);
          case 'hook':
            return abi.encodeFunctionResult(name, [constants.AddressZero]);
          case 'feeHook':
            feeHookRead();
            if (missingFeeHook) return '0x';
            if (failFeeHook) throw new Error('Fee hook RPC unavailable');
            return abi.encodeFunctionResult(name, [
              tokenIgp > 0n ? WRAPPER : constants.AddressZero,
            ]);
          case 'allowance':
            expect(args[0]).to.equal(SENDER);
            expect(args[1]).to.equal(predicate ? WRAPPER : ROUTER);
            return abi.encodeFunctionResult(name, [allowanceRead().toString()]);
          case 'quoteTransferRemote':
            if (failQuote) throw new Error('IGP RPC unavailable');
            expect(args[0]).to.equal(test2.domainId);
            expect(args[1]).to.equal(utils.hexZeroPad(SENDER, 32));
            expect(BigNumber.from(args[2]).toBigInt()).to.equal(AMOUNT);
            return abi.encodeFunctionResult(name, [
              [
                [
                  tokenIgp > 0n ? ROUTER : constants.AddressZero,
                  tokenIgp > 0n ? tokenIgp : nativeIgp,
                ],
                [ROUTER, AMOUNT + WARP_FEE],
                [ROUTER, 0n],
              ],
            ]);
          default:
            throw new Error(`Unexpected RPC read: ${name}`);
        }
      });
    if (predicate) {
      sandbox
        .stub(EvmHypSyntheticAdapter.prototype, 'getPredicateWrapperAddress')
        .resolves(WRAPPER);
    }
    const core = new WarpCore(multiProvider, [token]);
    const native = Token.FromChainMetadataNativeToken(
      multiProvider.getChainMetadata(test1.name),
    );
    const txs = await core.getTransferRemoteTxs({
      originTokenAmount: token.amount(AMOUNT),
      destination: test2.name,
      sender: SENDER,
      recipient: SENDER,
      ...(pinned && {
        interchainFee: native.amount(nativeIgp),
        tokenFeeQuote: token.amount(tokenIgp + WARP_FEE),
      }),
      ...(predicate && {
        attestation: {
          uuid: 'test',
          expiration: 4_000_000_000,
          attester: SENDER,
          signature: '0x1234',
        },
      }),
    });
    const approvals = txs
      .filter((tx) => tx.category !== WarpTxCategory.Transfer)
      .map((tx) => {
        if (
          (tx.type !== ProviderType.EthersV5 &&
            tx.type !== ProviderType.Tron) ||
          !tx.transaction.data
        )
          throw new Error('Expected EVM approval');
        return abi.parseTransaction({ data: tx.transaction.data }).args;
      });
    return { txs, approvals, allowanceRead, feeHookRead };
  }

  for (const standard of [
    TokenStandard.EvmHypSynthetic,
    TokenStandard.EvmHypSyntheticRebase,
    TokenStandard.TronHypSynthetic,
    TokenStandard.TronHypSyntheticRebase,
  ]) {
    for (const allowance of [
      0n,
      IGP,
      APPROVAL_AMOUNT - 1n,
      APPROVAL_AMOUNT,
      APPROVAL_AMOUNT + 1n,
    ]) {
      it(`${standard} funds the token IGP with allowance ${allowance}`, async () => {
        const { txs, approvals, allowanceRead } = await transfer({
          allowance,
          standard,
        });
        const categories =
          allowance === 0n
            ? [WarpTxCategory.Approval, WarpTxCategory.Transfer]
            : allowance < APPROVAL_AMOUNT
              ? [
                  WarpTxCategory.Revoke,
                  WarpTxCategory.Approval,
                  WarpTxCategory.Transfer,
                ]
              : [WarpTxCategory.Transfer];
        expect(txs.map((tx) => tx.category)).to.eql(categories);
        expect(
          approvals.map((args) => [
            args[0],
            BigNumber.from(args[1]).toBigInt(),
          ]),
        ).to.eql(
          allowance === 0n
            ? [[ROUTER, APPROVAL_AMOUNT]]
            : allowance < APPROVAL_AMOUNT
              ? [
                  [ROUTER, 0n],
                  [ROUTER, APPROVAL_AMOUNT],
                ]
              : [],
        );
        expect(allowanceRead.called).to.equal(true);
        const tx = txs.at(-1)!;
        if (
          (tx.type !== ProviderType.EthersV5 &&
            tx.type !== ProviderType.Tron) ||
          !tx.transaction.data
        )
          throw new Error('Expected EVM transfer');
        expect(
          abi
            .parseTransaction({ data: tx.transaction.data })
            .args[2].toBigInt(),
        ).to.equal(AMOUNT);
        expect(BigNumber.from(tx.transaction.value).toBigInt()).to.equal(0n);
      });
    }
  }

  it('also handles fees quoted internally by WarpCore', async () => {
    const { approvals } = await transfer({ pinned: false });
    expect(approvals[0][1].toBigInt()).to.equal(APPROVAL_AMOUNT);
  });

  for (const nativeIgp of [0n, 7n]) {
    it(`keeps burn-only route fees approval-free with native IGP ${nativeIgp}`, async () => {
      const { txs, allowanceRead } = await transfer({
        tokenIgp: 0n,
        nativeIgp,
      });
      expect(txs.map((tx) => tx.category)).to.eql([WarpTxCategory.Transfer]);
      expect(allowanceRead.called).to.equal(false);
    });
  }

  it('preserves the full transfer approval to the Predicate wrapper', async () => {
    const { approvals, txs } = await transfer({ predicate: true });
    expect(approvals[0][0]).to.equal(WRAPPER);
    expect(approvals[0][1].toBigInt()).to.equal(AMOUNT + IGP + WARP_FEE);
    const tx = txs.at(-1)!;
    if (tx.type !== ProviderType.EthersV5)
      throw new Error('Expected EVM transfer');
    expect(tx.transaction.to).to.equal(WRAPPER);
  });

  it('keeps legacy burn-only routers approval-free without reading feeHook', async () => {
    const { txs, allowanceRead, feeHookRead } = await transfer({
      contractVersion: '5.3.9',
      tokenIgp: 0n,
    });
    expect(txs.map((tx) => tx.category)).to.eql([WarpTxCategory.Transfer]);
    expect(allowanceRead.called).to.equal(false);
    expect(feeHookRead.called).to.equal(false);
  });

  for (const contractVersion of ['10.0.0', '10.2.0']) {
    for (const pinned of [true, false]) {
      it(`transfers on ${contractVersion} without a feeHook selector (${pinned ? 'pinned' : 'quoted'} fees)`, async () => {
        const { txs, allowanceRead, feeHookRead } = await transfer({
          contractVersion,
          pinned,
          missingFeeHook: true,
          tokenIgp: 0n,
          nativeIgp: 7n,
        });
        expect(txs.map((tx) => tx.category)).to.eql([WarpTxCategory.Transfer]);
        expect(allowanceRead.called).to.equal(false);
        expect(feeHookRead.called).to.equal(false);
      });
    }
  }

  it('propagates fee-hook read failures rather than omitting approval', async () => {
    try {
      await transfer({ failFeeHook: true });
      expect.fail('Expected fee-hook read failure');
    } catch (error: unknown) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal('Fee hook RPC unavailable');
    }
  });

  it('propagates IGP quote failures rather than omitting approval', async () => {
    try {
      await transfer({ failQuote: true, pinned: false });
      expect.fail('Expected IGP quote failure');
    } catch (error: unknown) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal('IGP RPC unavailable');
    }
  });
});
