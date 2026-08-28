import { expect } from 'chai';
import { createProgram, formatActionsTable, formatBalancesTable } from '../../src/cli/index';
import { ChainBalanceReport, FundingAction } from '../../src/types';

describe('Keyfunder CLI', () => {
  it('should render ascii table for funding actions', () => {
    const actions: FundingAction[] = [
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x1234567890123456789012345678901234567890',
        recipientName: 'relayer-1',
        currentBalance: 100000000000000000n,
        formattedCurrentBalance: '0.1',
        minThreshold: 500000000000000000n,
        formattedMinThreshold: '0.5',
        desiredBalance: 2000000000000000000n,
        formattedDesiredBalance: '2.0',
        requiredFunding: 1900000000000000000n,
        formattedRequiredFunding: '1.9',
        funderAddress: '0xFunder',
        funderBalance: 10000000000000000000n,
        formattedFunderBalance: '10.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      },
    ];

    const tableStr = formatActionsTable(actions);
    expect(tableStr).to.include('ethereum');
    expect(tableStr).to.include('relayer-1');
    expect(tableStr).to.include('1.9 ETH');
    expect(tableStr).to.include('PENDING');
  });

  it('should render ascii table for chain balances', () => {
    const reports: Record<string, ChainBalanceReport> = {
      ethereum: {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: 10000000000000000000n,
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            name: 'validator',
            balance: 100000000000000000n,
            formattedBalance: '0.1',
            minBalance: 500000000000000000n,
            formattedMinBalance: '0.5',
            desiredBalance: 2000000000000000000n,
            formattedDesiredBalance: '2.0',
            needsFunding: true,
            deficit: 1900000000000000000n,
            formattedDeficit: '1.9',
          },
        ],
      },
    };

    const tableStr = formatBalancesTable(reports);
    expect(tableStr).to.include('ethereum');
    expect(tableStr).to.include('validator');
    expect(tableStr).to.include('YES');
  });

  it('should create commander program with all subcommands', () => {
    const program = createProgram();
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).to.include.members(['check', 'run', 'start', 'topup']);
  });
});
