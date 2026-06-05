# PiggyBank Sponsor IGP

A pre-funded Interchain Gas Paymaster that allows app developers (sponsors) to pay
for their users' interchain gas costs. Users don't need to hold native gas tokens
on every chain — the sponsor covers the cost.

## How It Works

1. **Sponsor deploys** a PiggyBankSponsorIGP contract, configuring themselves as owner,
   a beneficiary (who collects fees), and a low-balance threshold.

2. **Sponsor deposits** native tokens (ETH) or ERC20 tokens into the contract.

3. **Sponsor configures** gas oracles and destination gas overheads (same mechanism
   as the standard InterchainGasPaymaster).

4. **Users dispatch** messages through their app (e.g., a warp route) which uses
   this contract as its post-dispatch hook. Gas costs are deducted from the
   sponsor's balance — users pay nothing.

5. **Relayer claims** collected payments from the contract's beneficiary address.

6. **Low-balance alert** — when the sponsor's balance drops below the configured
   threshold, a `LowBalanceWarning` event is emitted. A monitoring script can
   detect this and alert the sponsor to top up.

## Key Differences from Standard IGP

| Feature | Standard IGP | PiggyBank Sponsor IGP |
|---------|-------------|----------------------|
| Who pays | User (msg.sender) | Sponsor (pre-funded) |
| Payment model | Pay-per-use | Pre-funded balance |
| Beneficiary claim | claim()/claimToken() | Same |
| Low-balance alert | None | LowBalanceWarning event |
| Pricing | Gas oracle | Same oracle mechanism |
| Deployment | Per-chain default | Per-app (one sponsor each) |

## Deployment

```solidity
// Deploy with sponsor, beneficiary, and low-balance threshold
PiggyBankSponsorIGP piggyBank = new PiggyBankSponsorIGP(
    sponsorAddress,    // The app developer
    beneficiaryAddress, // Who collects relay fees
    1 ether            // Low-balance warning threshold
);
```

## Configuration

```solidity
// 1. Set gas oracles (same format as InterchainGasPaymaster)
PiggyBankSponsorIGP.TokenGasOracleConfig[] memory configs = new PiggyBankSponsorIGP.TokenGasOracleConfig[](1);
configs[0] = PiggyBankSponsorIGP.TokenGasOracleConfig(
    address(0),           // feeToken (address(0) = native)
    destinationDomain,    // remote domain
    gasOracleAddress      // StorageGasOracle or custom oracle
);
piggyBank.setTokenGasOracles(configs);

// 2. Set gas overhead per destination
piggyBank.setDestinationGasOverhead(destinationDomain, gasOverhead);

// 3. Set low-balance threshold
piggyBank.setLowBalanceThreshold(1 ether);

// 4. Deposit funds
piggyBank.deposit{value: 100 ether}();
```

## Using as a Hook

Configure your warp route or app to use the PiggyBankSponsorIGP as its
post-dispatch hook:

```solidity
// When deploying your warp route
warpRoute = new HypNative(1 ether, mailbox, piggyBank, ism);
```

Or set it on an existing warp route:
```solidity
warpRoute.setHook(piggyBank);
```

## Monitoring

Run the included balance check script:

```bash
# Install cast (Foundry) first
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Check balance
./scripts/check-piggybank-balance.sh \
    https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY \
    0xYourPiggyBankAddress \
    1000000000000000000  # 1 ETH threshold
```

Set up cron to check every hour:
```cron
0 * * * * /path/to/check-piggybank-balance.sh https://rpc.url 0xContract 1ether
```

## Functions

### Sponsor Operations
- `deposit()` — Deposit native tokens (payable)
- `depositERC20(token, amount)` — Deposit ERC20 tokens
- `withdraw(amount)` — Withdraw unused native tokens (owner only)
- `withdrawERC20(token, amount)` — Withdraw unused ERC20 tokens (owner only)

### Beneficiary Operations
- `claim()` — Claim accumulated native token payments
- `claimToken(token)` — Claim accumulated ERC20 token payments

### Owner Configuration
- `setBeneficiary(address)` — Set beneficiary
- `setTokenGasOracles(configs)` — Configure gas oracles
- `setDestinationGasOverhead(domain, overhead)` — Set per-domain gas overhead
- `setLowBalanceThreshold(threshold)` — Set low-balance warning threshold

### IGP Interface
- `payForGas(messageId, destination, gasLimit, refundAddress)` — Pay for gas (sponsor funds)
- `payForGas(token, messageId, destination, gasLimit)` — Pay for gas with ERC20 (sponsor funds)
- `quoteGasPayment(destination, gasLimit)` — Quote native gas payment
- `quoteGasPayment(token, destination, gasLimit)` — Quote ERC20 gas payment

### Hook Interface
- `postDispatch(metadata, message)` — Post-dispatch hook (sponsor pays)
- `quoteDispatch(metadata, message)` — Quote dispatch cost
