import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { Erc20ApprovalMode, approveErc20IfNeeded } from './erc20Approve.js';

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

  it('rejects non-positive approval amounts before reading allowance', async () => {
    try {
      await approveErc20IfNeeded(signer, token, spender, 0n, logger, {
        contractFactory,
      });
      expect.fail('Expected approval amount validation to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.equal(
          'ERC20 approval amount must be positive',
        );
      }
    }
    expect(contractFactory.called).to.equal(false);
  });

  it('returns when the exact allowance already matches', async () => {
    contract.allowanceStub.resolves(ethers.BigNumber.from(10));

    await approveErc20IfNeeded(signer, token, spender, 10n, logger, {
      contractFactory,
    });

    expect(contractFactory.callCount).to.equal(1);
    expect(contract.approveStub.called).to.equal(false);
  });

  it('sets a zero allowance to the exact requested amount', async () => {
    const approvalTx = makeTransaction('0xapprove');
    contract.allowanceStub.resolves(ethers.constants.Zero);
    contract.approveStub.resolves(approvalTx);

    await approveErc20IfNeeded(signer, token, spender, 25n, logger, {
      contractFactory,
    });

    expect(contract.approveStub.calledOnce).to.equal(true);
    expect(contract.approveStub.firstCall.args[0]).to.equal(spender);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).eq(25),
    ).to.equal(true);
    expect(approvalTx.wait.calledOnce).to.equal(true);
  });

  it('resets a differing nonzero allowance before setting the exact amount', async () => {
    const revokeTx = makeTransaction('0xrevoke');
    const approvalTx = makeTransaction('0xapprove');
    contract.allowanceStub.resolves(ethers.BigNumber.from(100));
    contract.approveStub.onCall(0).resolves(revokeTx);
    contract.approveStub.onCall(1).resolves(approvalTx);

    await approveErc20IfNeeded(signer, token, spender, 25n, logger, {
      contractFactory,
    });

    expect(contract.approveStub.callCount).to.equal(2);
    expect(contract.approveStub.firstCall.args).to.deep.equal([spender, 0]);
    expect(contract.approveStub.secondCall.args[0]).to.equal(spender);
    expect(
      ethers.BigNumber.from(contract.approveStub.secondCall.args[1]).eq(25),
    ).to.equal(true);
    expect(revokeTx.wait.calledOnce).to.equal(true);
    expect(approvalTx.wait.calledOnce).to.equal(true);
  });

  it('uses unlimited allowance only when explicitly requested', async () => {
    contract.allowanceStub.resolves(ethers.constants.Zero);
    contract.approveStub.resolves(makeTransaction('0xapprove'));

    await approveErc20IfNeeded(signer, token, spender, 1n, logger, {
      contractFactory,
      mode: Erc20ApprovalMode.Infinite,
    });

    expect(contract.approveStub.callCount).to.equal(1);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).eq(
        ethers.constants.MaxUint256,
      ),
    ).to.equal(true);
  });
});
