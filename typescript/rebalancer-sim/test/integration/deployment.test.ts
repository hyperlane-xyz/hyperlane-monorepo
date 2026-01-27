import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { ethers } from 'ethers';

import { ERC20Test__factory } from '@hyperlane-xyz/core';
import { toWei } from '@hyperlane-xyz/utils';

import {
  deployMultiDomainSimulation,
  getWarpTokenBalance,
  restoreSnapshot,
} from '../../src/deployment/SimulationDeployment.js';
import {
  ANVIL_DEPLOYER_KEY,
  DEFAULT_SIMULATED_CHAINS,
} from '../../src/deployment/types.js';

// Skip these tests unless RUN_ANVIL_TESTS is set
const describeIfAnvil = process.env.RUN_ANVIL_TESTS ? describe : describe.skip;

async function startAnvil(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const anvil = spawn('anvil', ['--port', port.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        anvil.kill();
        reject(new Error('Anvil startup timeout'));
      }
    }, 10000);
    anvil.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('Listening on')) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolve(anvil), 500);
      }
    });
    anvil.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describeIfAnvil('Multi-Domain Deployment', function () {
  this.timeout(120000);

  const anvilPort = 8546; // Use different port to avoid conflict with other tests
  const anvilRpc = `http://localhost:${anvilPort}`;
  let provider: ethers.providers.JsonRpcProvider;
  let anvilProcess: ChildProcess | null = null;

  before(async () => {
    anvilProcess = await startAnvil(anvilPort);
    provider = new ethers.providers.JsonRpcProvider(anvilRpc);
  });

  after(() => {
    if (anvilProcess) {
      anvilProcess.kill();
      anvilProcess = null;
    }
  });

  it('should deploy multi-domain simulation', async () => {
    const result = await deployMultiDomainSimulation({
      anvilRpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: DEFAULT_SIMULATED_CHAINS,
      initialCollateralBalance: BigInt(toWei(100)),
    });

    // Verify all domains deployed
    expect(Object.keys(result.domains).length).to.equal(3);

    for (const [chainName, domain] of Object.entries(result.domains)) {
      expect(domain.chainName).to.equal(chainName);
      expect(domain.mailbox).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.warpToken).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.collateralToken).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(domain.bridge).to.match(/^0x[a-fA-F0-9]{40}$/);

      // Verify balances
      const balance = await getWarpTokenBalance(
        provider,
        domain.warpToken,
        domain.collateralToken,
      );
      expect(balance.toString()).to.equal(toWei(100));
    }
  });

  it('should restore snapshot correctly', async () => {
    const initialBalance = BigInt(toWei(50));

    const result = await deployMultiDomainSimulation({
      anvilRpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: [{ chainName: 'test1', domainId: 9001 }],
      initialCollateralBalance: initialBalance,
    });

    const domain = result.domains['test1'];
    const deployer = new ethers.Wallet(ANVIL_DEPLOYER_KEY, provider);

    // Verify initial balance
    let balance = await getWarpTokenBalance(
      provider,
      domain.warpToken,
      domain.collateralToken,
    );
    expect(balance.toString()).to.equal(initialBalance.toString());

    // Modify state - mint more tokens to warp contract
    const token = ERC20Test__factory.connect(domain.collateralToken, deployer);
    await token.mintTo(domain.warpToken, toWei(100));

    // Verify balance changed
    balance = await getWarpTokenBalance(
      provider,
      domain.warpToken,
      domain.collateralToken,
    );
    expect(balance.toString()).to.equal(BigInt(toWei(150)).toString());

    // Restore snapshot
    await restoreSnapshot(provider, result.snapshotId);

    // Verify balance restored
    balance = await getWarpTokenBalance(
      provider,
      domain.warpToken,
      domain.collateralToken,
    );
    expect(balance.toString()).to.equal(initialBalance.toString());
  });
});
