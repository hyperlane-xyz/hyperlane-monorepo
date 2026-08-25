import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { Connection } from '@solana/web3.js';
import { StargateClient } from '@cosmjs/stargate';
import { KeyFunder } from '../../src/core/KeyFunder';
import { KeyfunderConfig } from '../../src/types';

describe('Keyfunder Multi-Protocol End-to-End Integration', () => {
  let keyfunder: KeyFunder;
  let mockEthProvider: any;
  let mockSolConnection: any;
  let mockCosmosClient: any;

  const multiChainConfig: KeyfunderConfig = {
    funder: {
      type: 'privateKey',
      key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      minReserve: {
        ethereum: '1.0',
        solana: '5.0',
        cosmos: '10.0',
      },
    },
    chains: {
      ethereum: {
        protocol: 'ethereum',
        rpcUrl: 'http://localhost:8545',
        recipients: [
          {
            name: 'evm-relayer',
            address: '0x1111111111111111111111111111111111111111',
            minBalance: '0.5',
            desiredBalance: '2.0',
          },
        ],
      },
      solana: {
        protocol: 'sealevel',
        rpcUrl: 'https://api.devnet.solana.com',
        recipients: [
          {
            name: 'solana-validator',
            address: '11111111111111111111111111111111',
            minBalance: '1.0',
            desiredBalance: '5.0',
          },
        ],
      },
      cosmos: {
        protocol: 'cosmos',
        rpcUrl: 'http://localhost:26657',
        strategyConfig: {
          type: 'direct',
          denom: 'uatom',
        },
        recipients: [
          {
            name: 'cosmos-deployer',
            address: 'cosmos1recipient123',
            minBalance: '2.0',
            desiredBalance: '10.0',
          },
        ],
      },
    },
  };

  beforeEach(() => {
    keyfunder = new KeyFunder(multiChainConfig);

    // Mock EVM Provider
    mockEthProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockEthProvider.getBalance.callsFake(async (addr: string) => {
      if (addr.toLowerCase() === '0x1111111111111111111111111111111111111111') {
        return ethers.parseEther('0.1'); // Below min (0.5), deficit = 1.9 ETH
      }
      return ethers.parseEther('50.0'); // Funder has 50 ETH
    });
    mockEthProvider.getFeeData.resolves({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: null,
    });
    mockEthProvider.getTransactionCount.resolves(0);

    keyfunder.balanceMonitor.setEvmProvider('http://localhost:8545', mockEthProvider as any);

    // Mock Solana Connection
    mockSolConnection = sinon.createStubInstance(Connection);
    mockSolConnection.getBalance.callsFake(async (pubkey: any) => {
      const pkStr = pubkey.toBase58 ? pubkey.toBase58() : String(pubkey);
      if (pkStr === '11111111111111111111111111111111') {
        return 500000000; // 0.5 SOL (< 1.0), deficit = 4.5 SOL = 4500000000 lamports
      }
      return 100000000000; // 100 SOL funder balance
    });
    keyfunder.balanceMonitor.setSolanaConnection('https://api.devnet.solana.com', mockSolConnection as any);

    // Mock Cosmos Client
    mockCosmosClient = sinon.createStubInstance(StargateClient);
    mockCosmosClient.getBalance.callsFake(async (addr: string, denom: string) => {
      if (addr === 'cosmos1recipient123') {
        return { denom: 'uatom', amount: '1000000' }; // 1.0 ATOM (< 2.0), deficit = 9.0 ATOM = 9000000 uatom
      }
      return { denom: 'uatom', amount: '1000000000' }; // 1000 ATOM funder balance
    });
    keyfunder.balanceMonitor.setCosmosClient('http://localhost:26657', mockCosmosClient as any);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should evaluate all 3 chains simultaneously in check()', async () => {
    const { reports, actions } = await keyfunder.check();

    expect(reports).to.have.property('ethereum');
    expect(reports).to.have.property('solana');
    expect(reports).to.have.property('cosmos');

    expect(actions).to.have.lengthOf(3);

    const ethAction = actions.find((a) => a.chain === 'ethereum');
    expect(ethAction?.status).to.equal('PENDING');
    expect(ethAction?.requiredFunding).to.equal(ethers.parseEther('1.9'));

    const solAction = actions.find((a) => a.chain === 'solana');
    expect(solAction?.status).to.equal('PENDING');
    expect(solAction?.requiredFunding).to.equal(4500000000n);

    const cosmosAction = actions.find((a) => a.chain === 'cosmos');
    expect(cosmosAction?.status).to.equal('PENDING');
    expect(cosmosAction?.requiredFunding).to.equal(9000000n);
  });

  it('should execute multi-chain funding in runOnce with dryRun', async () => {
    const { actions } = await keyfunder.runOnce({ dryRun: true });

    expect(actions).to.have.lengthOf(3);
    for (const a of actions) {
      expect(a.status).to.equal('EXECUTED');
      expect(a.txHash).to.include('dryrun');
    }
  });
});
