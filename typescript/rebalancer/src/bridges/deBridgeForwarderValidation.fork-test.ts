import { expect } from 'chai';
import { Contract, providers, utils } from 'ethers';

import {
  DLN_FORWARDER,
  DLN_FORWARDER_INTERFACE,
  ZERO_EX_ACTION_INTERFACE,
  validateDeBridgeForwarderDeployment,
} from './deBridgeForwarderValidation.js';
import {
  DLN_EVM_SOURCE,
  DLN_SOURCE_INTERFACE,
  validateDeBridgeEvmTransaction,
} from './deBridgeValidation.js';
import {
  changeCall,
  changeSwap,
  fixture,
  fixtureQuote,
  supportedForwarderData,
} from './fixtures/deBridgeForwarder.js';

// Run explicitly against a disposable local Anvil BSC fork; never part of unit tests.
// See fixtures/README.md for the pinned block and exact commands.
describe('deBridge source swap on a local BSC fork', function () {
  this.timeout(120_000);
  const url = process.env.DEBRIDGE_FORK_RPC;
  let provider: providers.JsonRpcProvider;
  let snapshot: string;
  let token: Contract;
  let output: Contract;
  let validData: string;
  const quote = fixtureQuote();
  const erc20 = [
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)',
  ];
  const events = new utils.Interface([
    'event CreatedOrder((uint64 makerOrderNonce,bytes makerSrc,uint256 giveChainId,bytes giveTokenAddress,uint256 giveAmount,uint256 takeChainId,bytes takeTokenAddress,uint256 takeAmount,bytes receiverDst,bytes givePatchAuthoritySrc,bytes orderAuthorityAddressDst,bytes allowedTakerDst,bytes allowedCancelBeneficiarySrc,bytes externalCall) order,bytes32 orderId,bytes affiliateFee,uint256 nativeFixFee,uint256 percentFee,uint32 referralCode,bytes metadata)',
  ]);

  async function mine(to: string, data: string, value = '0x0') {
    const hash = await provider.send('eth_sendTransaction', [
      {
        from: fixture.fromAddress,
        to,
        data,
        value,
        gas: '0x4c4b40',
      },
    ]);
    await provider.send('evm_mine', []);
    const receipt = await provider.getTransactionReceipt(hash);
    expect(receipt, 'Anvil must automine').not.to.equal(null);
    return receipt;
  }

  before(async () => {
    if (
      !url ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
    ) {
      throw new Error(
        'DEBRIDGE_FORK_RPC must name a disposable local Anvil fork',
      );
    }
    provider = new providers.JsonRpcProvider(url);
    const info = await provider.send('anvil_nodeInfo', []);
    expect(info.environment.chainId).to.equal(56);
    expect(info.forkConfig.forkBlockNumber).to.equal(
      Number(process.env.DEBRIDGE_FORK_BLOCK ?? 122011359),
    );
  });

  beforeEach(async () => {
    snapshot = await provider.send('evm_snapshot', []);
    await provider.send('anvil_impersonateAccount', [fixture.fromAddress]);
    await provider.send('anvil_setBalance', [
      fixture.fromAddress,
      utils.hexValue(utils.parseEther('10')),
    ]);
    const signer = provider.getSigner(fixture.fromAddress);
    token = new Contract(fixture.fromToken, erc20, signer);
    const outer = DLN_FORWARDER_INTERFACE.parseTransaction({
      data: supportedForwarderData(),
    }).args;
    output = new Contract(outer.srcTokenOut, erc20, signer);
    // The captured quote's funding deadline has expired. Refresh it only in this
    // constructed fork fixture; production code never rewrites provider calldata.
    const { timestamp } = await provider.getBlock('latest');
    validData = changeSwap(supportedForwarderData(), (swap) => {
      const next = [...swap];
      const actions = [...swap.actions];
      actions[0] = changeCall(
        ZERO_EX_ACTION_INTERFACE,
        actions[0],
        (funding) => {
          const updated = [...funding];
          updated[1] = { ...funding.permit, deadline: timestamp + 3600 };
          return updated;
        },
      );
      next[1] = actions;
      return next;
    });
    // Locate the balance mapping on this fork, verifying each candidate via balanceOf.
    for (let slot = 0; slot < 20; slot++) {
      const key = utils.keccak256(
        utils.defaultAbiCoder.encode(
          ['address', 'uint256'],
          [fixture.fromAddress, slot],
        ),
      );
      const previous = await provider.getStorageAt(token.address, key);
      await provider.send('anvil_setStorageAt', [
        token.address,
        key,
        utils.hexZeroPad(utils.hexlify(quote.fromAmount), 32),
      ]);
      if ((await token.balanceOf(fixture.fromAddress)).eq(quote.fromAmount))
        break;
      await provider.send('anvil_setStorageAt', [token.address, key, previous]);
    }
    expect((await token.balanceOf(fixture.fromAddress)).toString()).to.equal(
      quote.fromAmount.toString(),
    );
    expect(
      (
        await mine(
          token.address,
          token.interface.encodeFunctionData('approve', [
            DLN_FORWARDER,
            quote.fromAmount,
          ]),
        )
      ).status,
    ).to.equal(1);
  });

  afterEach(async () => {
    if (snapshot) await provider.send('evm_revert', [snapshot]);
  });

  it('spends the source allocation and atomically creates the validated destination order', async () => {
    const data = validData;
    validateDeBridgeEvmTransaction(quote, DLN_FORWARDER, data);
    await validateDeBridgeForwarderDeployment(provider, data);
    const before = await output.balanceOf(fixture.fromAddress);
    const outer = DLN_FORWARDER_INTERFACE.parseTransaction({ data }).args;
    const receipt = await mine(
      DLN_FORWARDER,
      data,
      utils.hexValue(BigInt(fixture.tx.value)),
    );
    expect(receipt.status).to.equal(1);
    expect((await token.balanceOf(fixture.fromAddress)).toString()).to.equal(
      '0',
    );
    expect(
      (await token.allowance(fixture.fromAddress, DLN_FORWARDER)).toString(),
    ).to.equal('0');
    expect((await output.balanceOf(fixture.fromAddress)).gte(before)).to.equal(
      true,
    );
    const orders = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === DLN_EVM_SOURCE.toLowerCase() &&
        log.topics[0] === events.getEventTopic('CreatedOrder'),
    );
    expect(orders).to.have.length(1);
    const { order, percentFee } = events.parseLog(orders[0]).args;
    expect(order.giveTokenAddress).to.equal(outer.srcTokenOut.toLowerCase());
    expect(order.giveAmount.add(percentFee).eq(outer.srcAmountOut)).to.equal(
      true,
    );
    expect(order.takeTokenAddress).to.equal(fixture.toToken);
    expect(order.takeChainId.toNumber()).to.equal(fixture.toChain);
    expect(order.takeAmount.gte(quote.toAmountMin)).to.equal(true);
    expect(order.receiverDst).to.equal(fixture.fromAddress.toLowerCase());
    expect(order.allowedTakerDst).to.equal(
      DLN_SOURCE_INTERFACE.parseTransaction({ data: outer.targetData }).args
        .order.allowedTakerDst,
    );
  });

  it('reverts without a source debit when the outer intermediate minimum cannot be met', async () => {
    const data = changeCall(DLN_FORWARDER_INTERFACE, validData, (args) => {
      const next = [...args];
      next[6] = quote.fromAmount * 2n;
      next[9] = changeCall(DLN_SOURCE_INTERFACE, args.targetData, (nested) => {
        const order = [...nested];
        order[0] = { ...nested.order, giveAmount: next[6] };
        return order;
      });
      return next;
    });
    const before = await token.balanceOf(fixture.fromAddress);
    const trace = await provider.send('debug_traceCall', [
      {
        from: fixture.fromAddress,
        to: DLN_FORWARDER,
        data,
        value: utils.hexValue(BigInt(fixture.tx.value)),
        gas: '0x4c4b40',
      },
      'latest',
      { tracer: 'callTracer' },
    ]);
    expect(trace.output).to.equal(
      utils.hexConcat([
        utils.id('NotEnoughSrcFundsIn(uint256)').slice(0, 10),
        utils.defaultAbiCoder.encode(['uint256'], [quote.fromAmount * 2n]),
      ]),
    );
    // RPC failures and timeouts fail the test instead of counting as a revert.
    const receipt = await mine(
      DLN_FORWARDER,
      data,
      utils.hexValue(BigInt(fixture.tx.value)),
    );
    expect(receipt.status).to.equal(0);
    expect(receipt.logs).to.have.length(0);
    expect((await token.balanceOf(fixture.fromAddress)).eq(before)).to.equal(
      true,
    );
  });
});
