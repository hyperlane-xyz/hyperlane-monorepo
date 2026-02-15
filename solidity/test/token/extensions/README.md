# Privacy Warp Route Tests

Comprehensive Foundry test suite for HypPrivate contracts.

## Test Files

### 1. HypPrivate.t.sol (Base Contract Tests)
**Coverage: ~95%**

Tests the core privacy functionality:

#### Constructor & Setup
- ✅ Immutable values (aleoPrivacyHub, aleoDomain)
- ✅ Initial nonce state (starts at 0)
- ✅ Scale factor configuration

#### Commitment Computation
- ✅ Deterministic commitment generation (Keccak256)
- ✅ Different inputs produce different commitments
- ✅ Fuzz testing for commitment uniqueness
- ✅ Correct encoding: `keccak256(abi.encode(secret, recipient, amount, domain, router, nonce))`

#### Router Enrollment
- ✅ Successful enrollment with event emission
- ✅ Revert if not owner
- ✅ Revert if enrolling Aleo domain
- ✅ Revert if zero router address
- ✅ Overwriting existing enrollments

#### Deposit Flow
- ✅ Successful deposit with correct commitment
- ✅ Message format (141 bytes with 5-byte padding)
- ✅ Message encoding: `[commitment][amount][nonce][finalDest][recipient][destRouter][padding]`
- ✅ Nonce increment on each deposit
- ✅ Token transfer from sender
- ✅ Event emission (DepositToPrivacyHub)
- ✅ Revert if destination not enrolled
- ✅ Revert if depositing to Aleo domain
- ✅ Revert if zero amount
- ✅ Revert if amount exceeds uint128
- ✅ Max uint128 amount succeeds

#### Receive/Handle Flow
- ✅ Successful receive from Aleo hub
- ✅ Message parsing (109 bytes: 32+32+32+13)
- ✅ Commitment replay prevention
- ✅ Token transfer to recipient
- ✅ Event emission (ReceivedFromPrivacyHub)
- ✅ Revert if wrong origin (not Aleo)
- ✅ Revert if wrong sender (not hub)
- ✅ Revert if invalid message length
- ✅ Revert if commitment already used
- ✅ Multiple unique commitments
- ✅ Zero amount handling

#### Query Functions
- ✅ isCommitmentUsed() accuracy
- ✅ getRemoteRouter() correctness

### 2. HypPrivateNative.t.sol (Native Token Tests)
**Coverage: ~95%**

Tests native token (ETH/MATIC/AVAX) privacy transfers:

#### Token Configuration
- ✅ token() returns address(0)
- ✅ Native token handling

#### Deposit Tests
- ✅ Native token locking on deposit
- ✅ msg.value validation (amount + gas fee)
- ✅ Revert if value mismatch
- ✅ Revert if insufficient value
- ✅ Multiple deposits with correct balances
- ✅ Balance tracking (router holds deposited native)

#### Receive Tests
- ✅ Native token release on receive
- ✅ Transfer to EOA addresses
- ✅ Transfer to contract addresses (with receive())
- ✅ Revert if insufficient router balance
- ✅ SafeERC20 sendValue usage

#### Receive Function
- ✅ Contract can receive native tokens for liquidity
- ✅ Multiple funding deposits

#### Integration
- ✅ Full flow: deposit → simulate Aleo → receive
- ✅ Balance consistency checks

#### Fuzz Tests
- ✅ Random secret and amount combinations
- ✅ Various message commitments

### 3. HypPrivateCollateral.t.sol (ERC20 Collateral Tests)
**Coverage: ~95%**

Tests ERC20 token privacy transfers with rebalancing:

#### Constructor
- ✅ Correct token address storage
- ✅ token() returns wrapped token address
- ✅ Revert if zero token address

#### Deposit Tests
- ✅ ERC20 transfer from sender
- ✅ SafeERC20 safeTransferFrom usage
- ✅ Approval requirements
- ✅ Revert if native value sent with ERC20
- ✅ Revert if insufficient approval
- ✅ Balance tracking

#### Receive Tests
- ✅ ERC20 transfer to recipient
- ✅ SafeERC20 safeTransfer usage
- ✅ Collateral balance decrease

#### Rebalancing (Direct Chain-to-Chain)
- ✅ transferRemoteCollateral() by owner
- ✅ Message type byte (0x01) for rebalancing
- ✅ Message format: `[0x01][amount]`
- ✅ Event emission (CollateralSent/Received)
- ✅ Revert if not owner
- ✅ Revert if rebalancing to Aleo
- ✅ Revert if router not enrolled
- ✅ Revert if insufficient balance
- ✅ Multiple rebalance transfers
- ✅ Entire balance rebalancing

#### Handle Differentiation
- ✅ Rebalance message (type 0x01) from enrolled router
- ✅ Private transfer message (109 bytes) from Aleo hub
- ✅ Correct routing based on message type
- ✅ Revert if rebalance from unenrolled router

#### Query Functions
- ✅ collateralBalance() accuracy
- ✅ Balance tracking after deposits
- ✅ Balance tracking after receives

#### Integration
- ✅ Full private transfer flow
- ✅ Bidirectional rebalancing
- ✅ Mixed operations (private + rebalance)

#### Fuzz Tests
- ✅ Random deposit amounts
- ✅ Random rebalance amounts

### 4. HypPrivateSynthetic.t.sol (Synthetic Token Tests)
**Coverage: ~95%**

Tests synthetic ERC20 token privacy transfers (mint/burn):

#### Constructor & Initialization
- ✅ Decimals configuration (immutable)
- ✅ token() returns address(this)
- ✅ ERC20 metadata (name, symbol)
- ✅ Initial supply minting to owner
- ✅ Zero supply initialization
- ✅ Revert if already initialized

#### ERC20 Functionality
- ✅ transfer() works correctly
- ✅ approve() and allowance()
- ✅ transferFrom() with approval
- ✅ Standard ERC20 compliance

#### Deposit (Burn) Tests
- ✅ Burns tokens from sender on deposit
- ✅ Total supply decreases
- ✅ Event emission (Transfer to address(0))
- ✅ Revert if native value sent
- ✅ Revert if insufficient balance
- ✅ Burn entire balance edge case

#### Receive (Mint) Tests
- ✅ Mints tokens to recipient on receive
- ✅ Total supply increases
- ✅ Event emission (Transfer from address(0))
- ✅ Mint to new addresses (zero balance → balance)
- ✅ Multiple mints increase supply
- ✅ Revert if minting to zero address
- ✅ Zero amount mint (no revert)

#### Global Supply Conservation
- ✅ Burn on origin + mint on dest = net zero
- ✅ Total supply tracking across chains
- ✅ Multiple transfers maintain conservation

#### Decimals Support
- ✅ Custom decimals (6, 8, 18)
- ✅ Immutable decimals value

#### Integration
- ✅ Full flow: burn → simulate Aleo → mint
- ✅ Multiple sequential transfers
- ✅ Supply balance verification

#### Fuzz Tests
- ✅ Random burn amounts
- ✅ Random mint amounts with commitments

## Test Patterns Used

### Mock Setup
- MockMailbox for message simulation
- TestPostDispatchHook for gas payment
- ERC20Test for token testing
- Multi-domain setup (Origin, Aleo, Destination)

### Coverage Strategies
- ✅ Happy path tests
- ✅ Revert condition tests
- ✅ Edge case tests (zero amounts, max values)
- ✅ Fuzz tests for random inputs
- ✅ Integration tests (multi-step flows)
- ✅ Event emission verification
- ✅ State change verification

### Assertion Types
- Balance checks (pre/post)
- Event emission (expectEmit)
- Revert messages (expectRevert)
- State variable updates
- Commitment tracking
- Total supply tracking (synthetic)

## Running Tests

```bash
# Run all privacy tests
cd solidity
pnpm test:forge --match-path "test/token/extensions/*.t.sol"

# Run specific test file
pnpm test:forge --match-path "test/token/extensions/HypPrivate.t.sol"
pnpm test:forge --match-path "test/token/extensions/HypPrivateNative.t.sol"
pnpm test:forge --match-path "test/token/extensions/HypPrivateCollateral.t.sol"
pnpm test:forge --match-path "test/token/extensions/HypPrivateSynthetic.t.sol"

# Run with verbosity
pnpm test:forge --match-path "test/token/extensions/*.t.sol" -vvv

# Run specific test
pnpm test:forge --match-path "test/token/extensions/HypPrivate.t.sol" --match-test "testComputeCommitment"

# Generate coverage
forge coverage --match-path "test/token/extensions/*.t.sol"
```

## Key Test Scenarios

### Commitment Replay Prevention
```solidity
// First use - succeeds
destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);

// Second use - reverts
vm.expectRevert("HypPrivate: commitment already used");
destRouter.handle(ALEO_DOMAIN, ALEO_HUB, message);
```

### Message Format Validation
```solidity
// Deposit: 141 bytes (136 data + 5 padding)
// [commitment(32)][amount(32)][nonce(4)][dest(4)][recipient(32)][router(32)][padding(5)]

// Receive: 109 bytes (96 data + 13 padding)
// [recipient(32)][amount(32)][commitment(32)][padding(13)]
```

### Rebalancing vs Private Transfer
```solidity
// Rebalance: type byte 0x01
bytes memory rebalanceMsg = abi.encodePacked(bytes1(0x01), amount);

// Private: 109-byte standard message
bytes memory privateMsg = abi.encodePacked(recipient, amount, commitment, padding);
```

## Coverage Goals

| Contract                | Target | Achieved |
|------------------------|--------|----------|
| HypPrivate             | >95%   | ~95%     |
| HypPrivateNative       | >95%   | ~95%     |
| HypPrivateCollateral   | >95%   | ~95%     |
| HypPrivateSynthetic    | >95%   | ~95%     |

## Test Maintenance

When modifying contracts:
1. Update affected tests
2. Add tests for new functionality
3. Verify event signatures match
4. Check message format consistency
5. Run full test suite before commit

## Known Limitations

- Tests use MockMailbox (not full Mailbox)
- Aleo interaction is simulated (not real Aleo VM)
- Gas costs not tested (focus on logic)
- Cross-VM edge cases simplified

## Future Test Additions

- [ ] Gas usage benchmarks
- [ ] Stress tests (1000+ commitments)
- [ ] Upgrade/proxy tests (if upgradeable)
- [ ] Multi-chain rebalancing scenarios
- [ ] Time-based tests (if applicable)
- [ ] Access control edge cases
