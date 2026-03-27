import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { eqAddress } from '@hyperlane-xyz/utils';

import { randomAddress } from '../test/testUtils.js';
import {
  buildErc20ApproveCall,
  buildErc20TransferCall,
  buildIcaCommitmentFromRawCalls,
  buildUniversalRouterExecuteCall,
  buildUniversalRouterV3SwapExactInCall,
  buildWarpTransferRemoteCall,
} from './CommitmentCalls.js';

describe('CommitmentCalls helpers', () => {
  it('builds ERC20 approve and transfer call payloads', () => {
    const token = randomAddress();
    const spender = randomAddress();
    const recipient = randomAddress();

    const approve = buildErc20ApproveCall({
      token,
      spender,
      amount: BigNumber.from(123),
    });
    const transfer = buildErc20TransferCall({
      token,
      recipient,
      amount: BigNumber.from(456),
    });

    const iface = new utils.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
      'function transfer(address to, uint256 amount) returns (bool)',
    ]);

    const decodedApprove = iface.decodeFunctionData('approve', approve.data);
    const decodedTransfer = iface.decodeFunctionData('transfer', transfer.data);

    expect(approve.to).to.equal(token);
    expect(eqAddress(decodedApprove[0], spender)).to.equal(true);
    expect(decodedApprove[1].toString()).to.equal('123');

    expect(transfer.to).to.equal(token);
    expect(eqAddress(decodedTransfer[0], recipient)).to.equal(true);
    expect(decodedTransfer[1].toString()).to.equal('456');
  });

  it('builds warp transferRemote calls with optional msg value', () => {
    const warpRoute = randomAddress();
    const recipient = randomAddress();

    const call = buildWarpTransferRemoteCall({
      warpRoute,
      destinationDomain: 8453,
      recipient,
      amount: BigNumber.from(1000),
      msgFee: BigNumber.from(25),
    });

    const iface = new utils.Interface([
      'function transferRemote(uint32 destinationDomain, bytes32 recipient, uint256 amount) payable returns (bytes32)',
    ]);
    const decoded = iface.decodeFunctionData('transferRemote', call.data);

    expect(call.to).to.equal(warpRoute);
    expect(call.value).to.equal('25');
    expect(decoded[0]).to.equal(8453);
    expect(decoded[2].toString()).to.equal('1000');
  });

  it('builds universal router execute call payloads', () => {
    const universalRouter = randomAddress();

    const call = buildUniversalRouterExecuteCall({
      universalRouter,
      commands: '0x1213',
      inputs: ['0x1234', '0xabcd'],
      deadline: BigNumber.from(1_700_000_000),
      value: BigNumber.from(7),
    });

    const iface = new utils.Interface([
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
    ]);
    const decoded = iface.decodeFunctionData('execute', call.data);

    expect(call.to).to.equal(universalRouter);
    expect(call.value).to.equal('7');
    expect(decoded[0]).to.equal('0x1213');
    expect(decoded[1]).to.deep.equal(['0x1234', '0xabcd']);
    expect(decoded[2].toString()).to.equal('1700000000');
  });

  it('builds universal router v3 exact-in swap call payloads', () => {
    const universalRouter = randomAddress();
    const recipient = randomAddress();
    const tokenIn = randomAddress();
    const tokenOut = randomAddress();

    const call = buildUniversalRouterV3SwapExactInCall({
      universalRouter,
      recipient,
      tokenIn,
      tokenOut,
      amountIn: BigNumber.from(1234),
      amountOutMinimum: BigNumber.from(5678),
      deadline: BigNumber.from(1_700_000_100),
      poolParam: 500,
      dexFlavor: 'uniswap-v3',
    });

    const execIface = new utils.Interface([
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
    ]);
    const decodedExec = execIface.decodeFunctionData('execute', call.data);

    expect(call.to).to.equal(universalRouter);
    expect(decodedExec[0]).to.equal('0x00');
    expect(decodedExec[1]).to.have.length(1);
    expect(decodedExec[2].toString()).to.equal('1700000100');

    const decodedSwap = utils.defaultAbiCoder.decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool'],
      decodedExec[1][0],
    );
    expect(eqAddress(decodedSwap[0], recipient)).to.equal(true);
    expect(decodedSwap[1].toString()).to.equal('1234');
    expect(decodedSwap[2].toString()).to.equal('5678');
    expect(decodedSwap[4]).to.equal(true);
    expect(decodedSwap[5]).to.equal(true);

    const expectedPath = utils.solidityPack(
      ['address', 'uint24', 'address'],
      [tokenIn, 500, tokenOut],
    );
    expect(decodedSwap[3]).to.equal(expectedPath);
  });

  it('rejects universal router v3 exact-in calls for identical tokens', () => {
    const token = randomAddress();
    expect(() =>
      buildUniversalRouterV3SwapExactInCall({
        universalRouter: randomAddress(),
        recipient: randomAddress(),
        tokenIn: token,
        tokenOut: token,
        amountIn: BigNumber.from(1),
        amountOutMinimum: BigNumber.from(1),
        deadline: BigNumber.from(1_700_000_000),
      }),
    ).to.throw('tokenIn and tokenOut must differ for destination swap');
  });

  it('buildIcaCommitmentFromRawCalls normalizes calls and builds matching commitment', () => {
    const token = randomAddress();
    const spender = randomAddress();
    const salt = '0x' + '11'.repeat(32);

    const approve = buildErc20ApproveCall({
      token,
      spender,
      amount: BigNumber.from(1000),
    });

    const payload = buildIcaCommitmentFromRawCalls([approve], salt);

    expect(payload.normalizedCalls).to.have.length(1);
    expect(payload.encodedCalls.startsWith(salt)).to.equal(true);
    expect(payload.commitment).to.match(/^0x[0-9a-fA-F]{64}$/);
  });

  it('buildIcaCommitmentFromRawCalls rejects empty call sets', () => {
    expect(() =>
      buildIcaCommitmentFromRawCalls([], '0x' + '22'.repeat(32)),
    ).to.throw('calls must contain at least one entry');
  });
});
