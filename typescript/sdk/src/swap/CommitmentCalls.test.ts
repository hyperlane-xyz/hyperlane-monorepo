import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { eqAddress } from '@hyperlane-xyz/utils';

import { randomAddress } from '../test/testUtils.js';
import {
  buildErc20ApproveCall,
  buildErc20TransferCall,
  buildIcaCommitmentFromRawCalls,
  buildUniversalRouterExecuteCall,
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
