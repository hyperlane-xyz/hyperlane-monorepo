import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  Erc20ApprovalMode,
  Erc20ApprovalError,
  approveErc20IfNeeded,
  revokeErc20Approval,
  revokeErc20ApprovalIfNeeded,
} from './erc20Approve.js';

const logger = pino({ level: 'silent' });
const token = '0x1111111111111111111111111111111111111111';
const spender = '0x2222222222222222222222222222222222222222';

function testReceipt(
  hash: string,
  status: number,
): ethers.providers.TransactionReceipt {
  return {
    to: token,
    from: spender,
    contractAddress: token,
    transactionIndex: 0,
    gasUsed: ethers.constants.Zero,
    logsBloom: '0x',
    blockHash: hash,
    transactionHash: hash,
    logs: [],
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: ethers.constants.Zero,
    effectiveGasPrice: ethers.constants.Zero,
    byzantium: true,
    type: 0,
    status,
  };
}

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
    const transport = new ethers.VoidSigner(
      ethers.constants.AddressZero,
      signer.provider,
    );
    super(
      token,
      ['function approve(address spender,uint256 amount) returns (bool)'],
      transport,
    );
    sinon.stub(transport, 'sendTransaction').callsFake(async (request) => {
      const [spender, amount] = this.interface.decodeFunctionData(
        'approve',
        (await request.data) ?? '0x',
      );
      const tx = await this.approveStub(spender, amount);
      return {
        hash: tx.hash,
        confirmations: 0,
        from: ethers.constants.AddressZero,
        nonce: 0,
        gasLimit: ethers.constants.Zero,
        data: '0x',
        value: ethers.constants.Zero,
        chainId: 1,
        wait: async () => testReceipt(tx.hash, (await tx.wait()).status),
      };
    });
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
  const signer = ethers.Wallet.createRandom().connect(
    new ethers.providers.StaticJsonRpcProvider(),
  );
  let contract: TestErc20Contract;
  let contractFactory: sinon.SinonStub<
    [string, string[], ethers.Signer],
    ethers.Contract
  >;

  beforeEach(() => {
    contract = new TestErc20Contract(signer);
    sinon
      .stub(signer.provider, 'waitForTransaction')
      .callsFake(async (hash) => {
        const transactions = await Promise.all(
          contract.approveStub.returnValues,
        );
        const transaction = transactions.find((tx) => tx.hash === hash);
        if (!transaction) throw new Error(`Missing test transaction ${hash}`);
        return testReceipt(hash, (await transaction.wait()).status);
      });
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
    expect(contract.approveStub.firstCall.args[0]).to.equal(spender);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).isZero(),
    ).to.equal(true);
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

describe('revokeErc20ApprovalIfNeeded', () => {
  const signer = ethers.Wallet.createRandom().connect(
    new ethers.providers.StaticJsonRpcProvider(),
  );
  let contract: TestErc20Contract;
  let contractFactory: sinon.SinonStub<
    [string, string[], ethers.Signer],
    ethers.Contract
  >;

  beforeEach(() => {
    contract = new TestErc20Contract(signer);
    sinon
      .stub(signer.provider, 'waitForTransaction')
      .callsFake(async (hash) => {
        const transactions = await Promise.all(
          contract.approveStub.returnValues,
        );
        const transaction = transactions.find((tx) => tx.hash === hash);
        if (!transaction) throw new Error(`Missing test transaction ${hash}`);
        return testReceipt(hash, (await transaction.wait()).status);
      });
    contractFactory = sinon.stub<
      [string, string[], ethers.Signer],
      ethers.Contract
    >();
    contractFactory.returns(contract);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('skips cleanup when the allowance is zero', async () => {
    contract.allowanceStub.resolves(ethers.constants.Zero);

    await revokeErc20ApprovalIfNeeded(signer, token, spender, logger, {
      contractFactory,
    });

    expect(contract.approveStub.called).to.equal(false);
  });

  it('revokes residue and waits for its receipt', async () => {
    const revokeTx = makeTransaction('0xrevoke');
    contract.allowanceStub.resolves(ethers.BigNumber.from(3));
    contract.approveStub.resolves(revokeTx);

    await revokeErc20ApprovalIfNeeded(signer, token, spender, logger, {
      contractFactory,
    });

    expect(contract.approveStub.calledOnce).to.equal(true);
    expect(contract.approveStub.firstCall.args[0]).to.equal(spender);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).isZero(),
    ).to.equal(true);
    expect(revokeTx.wait.calledOnce).to.equal(true);
  });

  it('can force a revocation without reading allowance', async () => {
    const revokeTx = makeTransaction('0xrevoke');
    contract.approveStub.resolves(revokeTx);

    await revokeErc20Approval(signer, token, spender, logger, {
      contractFactory,
    });

    expect(contract.allowanceStub.called).to.equal(false);
    expect(contract.approveStub.calledOnce).to.equal(true);
    expect(contract.approveStub.firstCall.args[0]).to.equal(spender);
    expect(
      ethers.BigNumber.from(contract.approveStub.firstCall.args[1]).isZero(),
    ).to.equal(true);
    expect(revokeTx.wait.calledOnce).to.equal(true);
  });
});

describe('approval submission boundaries', () => {
  afterEach(() => sinon.restore());

  function harness() {
    const provider = new ethers.providers.StaticJsonRpcProvider();
    const signer = ethers.Wallet.createRandom().connect(provider);
    sinon
      .stub(provider, 'call')
      .resolves(ethers.utils.defaultAbiCoder.encode(['uint256'], [0]));
    const prepare = sinon
      .stub(signer, 'populateTransaction')
      .callsFake(async (request) => ({
        to: await request.to,
        data: await request.data,
        nonce: 0,
        gasLimit: ethers.BigNumber.from(50_000),
        gasPrice: ethers.BigNumber.from(1),
        value: ethers.constants.Zero,
        chainId: 1,
      }));
    const send = sinon.stub(provider, 'sendTransaction');
    const wait = sinon.stub(provider, 'waitForTransaction');
    const onApproval = sinon.spy();
    return { signer, prepare, send, wait, onApproval };
  }

  it('retains the locally signed approval hash when a broadcast response is lost', async () => {
    const h = harness();
    h.send.rejects(new Error('lost response'));
    let caught: unknown;
    try {
      await approveErc20IfNeeded(h.signer, token, spender, 25n, logger, {
        onApproval: h.onApproval,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Erc20ApprovalError);
    if (caught instanceof Erc20ApprovalError) {
      expect(caught.submissionState).to.equal('unknown');
      expect(caught.txHash).to.equal(
        ethers.utils.keccak256(await h.send.firstCall.args[0]),
      );
      expect(caught.token).to.equal(token);
      expect(caught.spender).to.equal(spender);
      expect(h.onApproval.firstCall.args[0].txHash).to.equal(caught.txHash);
    }
    expect(h.onApproval.calledBefore(h.send)).to.equal(true);
    expect(h.wait.called).to.equal(false);
  });

  it('classifies approval preparation failures as unsubmitted', async () => {
    const h = harness();
    h.prepare.rejects(new Error('cannot prepare'));
    let caught: unknown;
    try {
      await approveErc20IfNeeded(h.signer, token, spender, 25n, logger, {
        onApproval: h.onApproval,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Erc20ApprovalError);
    if (caught instanceof Erc20ApprovalError)
      expect(caught.submissionState).to.equal('not_submitted');
    expect(h.send.called).to.equal(false);
    expect(h.onApproval.called).to.equal(false);
  });

  it('publishes approval identity before receipt polling and clears it only after confirmation', async () => {
    const h = harness();
    const txHash = `0x${'ab'.repeat(32)}`;
    h.send.resolves({
      hash: txHash,
      confirmations: 0,
      from: h.signer.address,
      nonce: 0,
      gasLimit: ethers.constants.Zero,
      data: '0x',
      value: ethers.constants.Zero,
      chainId: 1,
      wait: async () => testReceipt(txHash, 1),
    });
    h.wait.callsFake(async () => {
      expect(h.onApproval.lastCall.args[0].txHash).to.equal(txHash);
      return testReceipt(txHash, 1);
    });
    await approveErc20IfNeeded(h.signer, token, spender, 25n, logger, {
      onApproval: h.onApproval,
    });
    expect(h.onApproval.lastCall.args[0]).to.equal(undefined);
  });
});
