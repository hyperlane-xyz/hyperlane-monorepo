import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { approveErc20IfNeeded } from './erc20Approve.js';

const logger = pino({ level: 'silent' });
const token = '0x1111111111111111111111111111111111111111';
const spender = '0x2222222222222222222222222222222222222222';
interface TestTransaction {
  hash: string;
  wait: sinon.SinonStub<[], Promise<{ status: number }>>;
}

function makeTransaction(hash: string): TestTransaction {
  return {
    hash,
    wait: sinon.stub<[], Promise<{ status: number }>>().resolves({ status: 1 }),
  };
}

class TestErc20Contract extends ethers.Contract {
  readonly allowanceStub = sinon.stub<
    [string, string],
    Promise<ethers.BigNumber>
  >();
  readonly decimalsStub = sinon.stub<[], Promise<number>>();
  readonly approveStub = sinon.stub<
    [string, ethers.BigNumberish],
    Promise<TestTransaction>
  >();

  constructor(signer: ethers.Signer) {
    super(token, [], signer);
  }

  allowance(owner: string, approvedSpender: string): Promise<ethers.BigNumber> {
    return this.allowanceStub(owner, approvedSpender);
  }

  decimals(): Promise<number> {
    return this.decimalsStub();
  }

  approve(
    approvedSpender: string,
    amount: ethers.BigNumberish,
  ): Promise<TestTransaction> {
    return this.approveStub(approvedSpender, amount);
  }
}

describe('approveErc20IfNeeded', () => {
  const signer = ethers.Wallet.createRandom();
  let contract: TestErc20Contract;
  let contractFactory: sinon.SinonStub<
    [string, string[], ethers.Signer],
    ethers.Contract
  >;

  beforeEach(() => {
    contract = new TestErc20Contract(signer);
    contractFactory = sinon.stub<
      [string, string[], ethers.Signer],
      ethers.Contract
    >();
    contractFactory.returns(contract);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns early when allowance is sufficient', async () => {
    contract.allowanceStub.resolves(ethers.BigNumber.from(10));

    await approveErc20IfNeeded(
      signer,
      token,
      spender,
      10n,
      logger,
      contractFactory,
    );

    expect(contractFactory.callCount).to.equal(1);
    expect(contract.decimalsStub.called).to.equal(false);
    expect(contract.approveStub.called).to.equal(false);
  });

  it('revokes a nonzero insufficient allowance before approving', async () => {
    const revokeTx = makeTransaction('0xrevoke');
    const approvalTx = makeTransaction('0xapprove');
    contract.allowanceStub.resolves(ethers.BigNumber.from(1));
    contract.decimalsStub.resolves(6);
    contract.approveStub.onCall(0).resolves(revokeTx);
    contract.approveStub.onCall(1).resolves(approvalTx);

    await approveErc20IfNeeded(
      signer,
      token,
      spender,
      2n,
      logger,
      contractFactory,
    );

    expect(contract.approveStub.callCount).to.equal(2);
    expect(contract.approveStub.firstCall.args[0]).to.equal(spender);
    expect(contract.approveStub.firstCall.args[1]).to.equal(0);
    expect(contract.approveStub.secondCall.args[0]).to.equal(spender);
    expect(revokeTx.wait.calledOnce).to.equal(true);
    expect(approvalTx.wait.calledOnce).to.equal(true);
  });

  it('passes the decimals-aware buffered target to approve', async () => {
    contract.allowanceStub.resolves(ethers.constants.Zero);
    contract.decimalsStub.resolves(6);
    contract.approveStub.resolves(makeTransaction('0xapprove'));

    await approveErc20IfNeeded(
      signer,
      token,
      spender,
      750_000n * 10n ** 6n,
      logger,
      contractFactory,
    );

    expect(contract.approveStub.callCount).to.equal(1);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).toString(),
    ).to.equal((1_000_000n * 10n ** 6n).toString());
  });

  it('approves MaxUint256 in infinite mode', async () => {
    contract.allowanceStub.resolves(ethers.constants.Zero);
    contract.approveStub.resolves(makeTransaction('0xapprove'));

    await approveErc20IfNeeded(
      signer,
      token,
      spender,
      1n,
      logger,
      contractFactory,
      true,
    );

    expect(contract.decimalsStub.called).to.equal(false);
    expect(contract.approveStub.callCount).to.equal(1);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).eq(
        ethers.constants.MaxUint256,
      ),
    ).to.equal(true);
  });
});
