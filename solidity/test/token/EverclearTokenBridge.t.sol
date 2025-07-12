// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";

import {EverclearTokenBridge, OutputAssetInfo} from "../../contracts/token/bridge/EverclearTokenBridge.sol";
import {EverclearEthBridge} from "../../contracts/token/bridge/EverclearEthBridge.sol";
import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../contracts/interfaces/IEverclearAdapter.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {IWETH} from "contracts/token/interfaces/IWETH.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
/**
 * @notice Mock implementation of IEverclearAdapter for testing
 */
contract MockEverclearAdapter is IEverclearAdapter {
    uint256 public constant INTENT_FEE = 1000; // 0.001 ETH
    bool public shouldRevert = false;
    bytes32 public lastIntentId;
    IEverclear.Intent public lastIntent;

    // Track calls for verification
    uint256 public newIntentCallCount;
    uint32[] public lastDestinations;
    bytes32 public lastReceiver;
    address public lastInputAsset;
    bytes32 public lastOutputAsset;
    uint256 public lastAmount;
    uint24 public lastMaxFee;
    uint48 public lastTtl;
    bytes public lastData;
    FeeParams public lastFeeParams;

    function setRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function newIntent(
        uint32[] memory _destinations,
        bytes32 _receiver,
        address _inputAsset,
        bytes32 _outputAsset,
        uint256 _amount,
        uint24 _maxFee,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    ) external payable override returns (bytes32, IEverclear.Intent memory) {
        if (shouldRevert) {
            revert("MockEverclearAdapter: reverted");
        }

        // Store call data for verification
        newIntentCallCount++;
        lastDestinations = _destinations;
        lastReceiver = _receiver;
        lastInputAsset = _inputAsset;
        lastOutputAsset = _outputAsset;
        lastAmount = _amount;
        lastMaxFee = _maxFee;
        lastTtl = _ttl;
        lastData = _data;
        lastFeeParams = _feeParams;

        // Generate mock intent ID
        lastIntentId = keccak256(
            abi.encodePacked(block.timestamp, _receiver, _amount)
        );

        // Create mock intent
        lastIntent = IEverclear.Intent({
            initiator: bytes32(uint256(uint160(msg.sender))),
            receiver: _receiver,
            inputAsset: bytes32(uint256(uint160(_inputAsset))),
            outputAsset: _outputAsset,
            maxFee: _maxFee,
            origin: uint32(block.chainid),
            destinations: _destinations,
            nonce: uint64(newIntentCallCount),
            timestamp: uint48(block.timestamp),
            ttl: _ttl,
            amount: _amount,
            data: _data
        });

        return (lastIntentId, lastIntent);
    }

    function feeSigner() external view returns (address) {
        return address(0x222);
    }

    function owner() external view returns (address) {
        return address(0x1);
    }

    function updateFeeSigner(address _feeSigner) external {
        // Do nothing
    }

    function spoke() external view returns (IEverclearSpoke) {
        return IEverclearSpoke(address(0x333));
    }
}

contract EverclearTokenBridgeTest is Test {
    using TypeCasts for *;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1e18;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    uint256 internal constant FEE_AMOUNT = 5e18; // 5 tokens fee
    uint256 internal constant GAS_PAYMENT = 0.001 ether;
    string internal constant NAME = "TestToken";
    string internal constant SYMBOL = "TT";
    MockHyperlaneEnvironment internal environment;

    // Test addresses
    address internal ALICE = makeAddr("alice");
    address internal constant BOB = address(0x2);
    address internal constant OWNER = address(0x3);
    address internal constant PROXY_ADMIN = address(0x37);

    // Mock contracts
    ERC20Test internal token;
    MockMailbox internal mailbox;
    MockEverclearAdapter internal everclearAdapter;
    TestPostDispatchHook internal hook;

    // Main contract
    EverclearTokenBridge internal bridge;

    // Test data
    bytes32 internal constant OUTPUT_ASSET = bytes32(uint256(0x456));
    bytes32 internal constant RECIPIENT = bytes32(uint256(uint160(BOB)));
    uint256 internal feeDeadline;
    bytes internal feeSignature = hex"1234567890abcdef";

    // Events to test
    event FeeParamsUpdated(uint256 fee, uint256 deadline);
    event OutputAssetSet(uint32 destination, bytes32 outputAsset);

    function setUp() public {
        // Setup basic infrastructure
        environment = new MockHyperlaneEnvironment(ORIGIN, DESTINATION);
        mailbox = environment.mailboxes(ORIGIN);

        token = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);
        everclearAdapter = new MockEverclearAdapter();
        hook = new TestPostDispatchHook();

        // Set fee deadline to future
        feeDeadline = block.timestamp + 3600; // 1 hour from now

        // Deploy bridge implementation
        EverclearTokenBridge implementation = new EverclearTokenBridge(
            address(token),
            1,
            address(mailbox),
            everclearAdapter
        );

        // Deploy proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(EverclearTokenBridge.initialize, (address(0), OWNER))
        );

        bridge = EverclearTokenBridge(address(proxy));
        // Setup initial state
        vm.startPrank(OWNER);
        bridge.setFeeParams(FEE_AMOUNT, feeDeadline, feeSignature);
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: DESTINATION,
                outputAsset: OUTPUT_ASSET
            })
        );
        bridge.enrollRemoteRouter(DESTINATION, RECIPIENT);

        vm.stopPrank();

        // Mint tokens to users
        token.mintTo(ALICE, 1000e18);

        // Setup allowances
        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);
    }

    // ============ Constructor Tests ============

    function testConstructor() public {
        EverclearTokenBridge newBridge = new EverclearTokenBridge(
            address(token),
            1,
            address(mailbox),
            everclearAdapter
        );

        assertEq(address(newBridge.token()), address(token));
        assertEq(
            address(newBridge.everclearAdapter()),
            address(everclearAdapter)
        );
    }

    // ============ Initialize Tests ============

    function testInitialize() public {
        assertEq(bridge.owner(), OWNER);
        assertEq(
            token.allowance(address(bridge), address(everclearAdapter)),
            type(uint256).max
        );
    }

    function testInitializeCannotBeCalledTwice() public {
        vm.expectRevert("Initializable: contract is already initialized");
        bridge.initialize(address(0), OWNER);
    }

    // ============ setFeeParams Tests ============

    function testSetFeeParams() public {
        uint256 newFee = 10e18;
        uint256 newDeadline = block.timestamp + 7200;
        bytes memory newSig = hex"abcdef";

        vm.expectEmit(true, true, false, true);
        emit FeeParamsUpdated(newFee, newDeadline);

        vm.prank(OWNER);
        bridge.setFeeParams(newFee, newDeadline, newSig);

        (uint256 fee, uint256 deadline, bytes memory sig) = bridge.feeParams();
        assertEq(fee, newFee);
        assertEq(deadline, newDeadline);
        assertEq(sig, newSig);
    }

    function testSetFeeParamsOnlyOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        bridge.setFeeParams(FEE_AMOUNT, feeDeadline, feeSignature);
    }

    // ============ setOutputAsset Tests ============

    function testSetOutputAsset() public {
        bytes32 newOutputAsset = bytes32(uint256(0x789));

        vm.expectEmit(true, true, false, true);
        emit OutputAssetSet(DESTINATION, newOutputAsset);

        vm.prank(OWNER);
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: DESTINATION,
                outputAsset: newOutputAsset
            })
        );

        assertEq(bridge.outputAssets(DESTINATION), newOutputAsset);
    }

    function testSetOutputAssetOnlyOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: DESTINATION,
                outputAsset: OUTPUT_ASSET
            })
        );
    }

    // ============ setOutputAssetsBatch Tests ============

    function testSetOutputAssetsBatch() public {
        OutputAssetInfo[] memory outputAssetInfos = new OutputAssetInfo[](2);
        outputAssetInfos[0] = OutputAssetInfo({
            destination: 13,
            outputAsset: bytes32(uint256(0x111))
        });
        outputAssetInfos[1] = OutputAssetInfo({
            destination: 14,
            outputAsset: bytes32(uint256(0x222))
        });

        vm.expectEmit(true, true, false, true);
        emit OutputAssetSet(13, outputAssetInfos[0].outputAsset);
        vm.expectEmit(true, true, false, true);
        emit OutputAssetSet(14, outputAssetInfos[1].outputAsset);

        vm.prank(OWNER);
        bridge.setOutputAssetsBatch(outputAssetInfos);

        assertEq(bridge.outputAssets(13), outputAssetInfos[0].outputAsset);
        assertEq(bridge.outputAssets(14), outputAssetInfos[1].outputAsset);
    }

    function testSetOutputAssetsBatchOnlyOwner() public {
        OutputAssetInfo[] memory outputAssetInfos = new OutputAssetInfo[](1);
        outputAssetInfos[0] = OutputAssetInfo({
            destination: 13,
            outputAsset: bytes32(uint256(0x111))
        });

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        bridge.setOutputAssetsBatch(outputAssetInfos);
    }

    // ============ quoteTransferRemote Tests ============

    function testQuoteTransferRemote() public {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMT
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0); // Gas payment is 0 for test dispatch hooks
        assertEq(quotes[1].token, address(token));
        assertEq(quotes[1].amount, TRANSFER_AMT + FEE_AMOUNT);
    }

    // ============ transferRemote Tests ============

    function testTransferRemote() public {
        uint256 initialBalance = token.balanceOf(ALICE);
        uint256 initialBridgeBalance = token.balanceOf(address(bridge));

        vm.prank(ALICE);
        bytes32 result = bridge.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMT
        );

        // Check balances
        assertEq(
            token.balanceOf(ALICE),
            initialBalance - TRANSFER_AMT - FEE_AMOUNT
        );
        assertEq(
            token.balanceOf(address(bridge)),
            initialBridgeBalance + TRANSFER_AMT + FEE_AMOUNT
        );

        // Check Everclear adapter was called correctly
        assertEq(everclearAdapter.newIntentCallCount(), 1);
        assertEq(everclearAdapter.lastDestinations(0), DESTINATION);
        assertEq(everclearAdapter.lastReceiver(), RECIPIENT);
        assertEq(everclearAdapter.lastInputAsset(), address(token));
        assertEq(everclearAdapter.lastOutputAsset(), OUTPUT_ASSET);
        assertEq(everclearAdapter.lastAmount(), TRANSFER_AMT);
        assertEq(everclearAdapter.lastMaxFee(), 0);
        assertEq(everclearAdapter.lastTtl(), 0);
        assertEq(
            everclearAdapter.lastData(),
            abi.encode(
                RECIPIENT.bytes32ToAddress(), // recipient address doubles as remote router address
                abi.encodeCall(
                    bridge.sendTokensFromIntent,
                    (RECIPIENT, TRANSFER_AMT)
                )
            )
        );

        // Check fee params
        (uint256 fee, uint256 deadline, bytes memory sig) = everclearAdapter
            .lastFeeParams();
        assertEq(fee, FEE_AMOUNT);
        assertEq(deadline, feeDeadline);
        assertEq(sig, feeSignature);
    }

    function testTransferRemoteOutputAssetNotSet() public {
        vm.expectRevert("ETB: Output asset not set");
        vm.prank(ALICE);
        bridge.transferRemote(999, RECIPIENT, TRANSFER_AMT); // Domain 999 has no output asset
    }

    function testTransferRemoteInsufficientBalance() public {
        // Try to transfer more than balance + fee
        uint256 aliceBalance = token.balanceOf(ALICE);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, aliceBalance);
    }

    function testTransferRemoteInsufficientAllowance() public {
        vm.prank(ALICE);
        token.approve(address(bridge), TRANSFER_AMT); // Less than transfer + fee

        vm.expectRevert("ERC20: insufficient allowance");
        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, TRANSFER_AMT);
    }

    function testTransferRemoteEverclearAdapterReverts() public {
        everclearAdapter.setRevert(true);

        vm.expectRevert("MockEverclearAdapter: reverted");
        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, TRANSFER_AMT);
    }

    // ============ Edge Cases Tests ============

    function testTransferRemoteZeroAmount() public {
        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, 0);

        // Should still charge fee
        assertEq(everclearAdapter.lastAmount(), 0);
        // Fee should still be deducted
        assertEq(token.balanceOf(ALICE), 1000e18 - FEE_AMOUNT);
    }

    function testTransferRemoteMaxAmount() public {
        uint256 maxAmount = token.balanceOf(ALICE) - FEE_AMOUNT;

        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, maxAmount);

        assertEq(everclearAdapter.lastAmount(), maxAmount);
        assertEq(token.balanceOf(ALICE), 0);
    }

    // ============ Fuzz Tests ============

    function testFuzzTransferRemote(uint256 amount) public {
        // Bound the amount to reasonable values
        amount = bound(amount, 0, 500e18); // Max 500 tokens

        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, amount);

        assertEq(everclearAdapter.lastAmount(), amount);
        assertEq(token.balanceOf(ALICE), 1000e18 - amount - FEE_AMOUNT);
    }

    function testFuzzSetFeeParams(uint256 fee, uint256 deadline) public {
        // Bound to reasonable values
        fee = bound(fee, 0, 100e18);
        deadline = bound(
            deadline,
            block.timestamp + 1,
            block.timestamp + 365 days
        );

        vm.prank(OWNER);
        bridge.setFeeParams(fee, deadline, feeSignature);

        (uint256 storedFee, uint256 storedDeadline, ) = bridge.feeParams();
        assertEq(storedFee, fee);
        assertEq(storedDeadline, deadline);
    }

    // ============ Integration Tests ============

    function testFullTransferFlow() public {
        // Setup: Alice wants to transfer 100 tokens to Bob on destination chain
        uint256 transferAmount = 100e18;
        uint256 initialAliceBalance = token.balanceOf(ALICE);

        // 1. Get quote
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            transferAmount
        );
        uint256 tokenCost = quotes[1].amount; // Token cost including fee

        // 2. Execute transfer
        vm.prank(ALICE);
        bytes32 transferId = bridge.transferRemote(
            DESTINATION,
            RECIPIENT,
            transferAmount
        );

        // 3. Verify state changes
        assertEq(token.balanceOf(ALICE), initialAliceBalance - tokenCost);

        // 4. Verify Everclear intent was created correctly
        assertEq(everclearAdapter.newIntentCallCount(), 1);
        assertEq(everclearAdapter.lastAmount(), transferAmount);
        assertEq(everclearAdapter.lastReceiver(), RECIPIENT);
        assertEq(everclearAdapter.lastOutputAsset(), OUTPUT_ASSET);
    }

    function testMultipleTransfers() public {
        uint256 transferAmount = 50e18;

        // Execute multiple transfers
        vm.startPrank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, transferAmount);
        bridge.transferRemote(DESTINATION, RECIPIENT, transferAmount);
        vm.stopPrank();

        // Verify both transfers were processed
        assertEq(everclearAdapter.newIntentCallCount(), 2);
        assertEq(
            token.balanceOf(ALICE),
            1000e18 - 2 * (transferAmount + FEE_AMOUNT)
        );
    }
}

/**
 * @notice Fork test contract for EverclearTokenBridge on Arbitrum
 * @dev Tests the bridge using real Arbitrum state and contracts with WETH transfers to Optimism
 * @dev We're running the cancun evm version, to avoid `NotActivated` errors
 * forge-config: default.evm_version = "cancun"
 */
contract EverclearTokenBridgeForkTest is Test {
    using TypeCasts for address;

    // Arbitrum mainnet constants
    uint32 internal constant ARBITRUM_DOMAIN = 42161;
    uint32 internal constant OPTIMISM_DOMAIN = 10; // Optimism destination

    // Real Arbitrum addresses
    address internal constant ARBITRUM_WETH =
        0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address internal constant EVERCLEAR_ADAPTER =
        0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75;

    // Optimism WETH address (for output asset)
    address internal constant OPTIMISM_WETH =
        0x4200000000000000000000000000000000000006;

    // Test constants
    uint256 internal constant FEE_AMOUNT = 1e16; // 0.01 WETH fee

    // Test addresses
    address internal ALICE = makeAddr("alice");
    address internal constant BOB = address(0x2);
    address internal constant OWNER = address(0x3);
    address internal constant PROXY_ADMIN = address(0x37);

    // Contracts
    IWETH internal weth;
    IEverclearAdapter internal everclearAdapter;
    EverclearTokenBridge internal bridge;

    // Test data
    bytes32 internal constant OUTPUT_ASSET =
        bytes32(uint256(uint160(OPTIMISM_WETH)));
    bytes32 internal constant RECIPIENT = bytes32(uint256(uint160(BOB)));
    uint256 internal feeDeadline;
    address internal feeSigner;
    bytes internal feeSignature = hex"123f"; // We will create a real signature in setUp

    function setUp() public virtual {
        // Fork Arbitrum at the latest block
        vm.createSelectFork("arbitrum");

        weth = IWETH(ARBITRUM_WETH);
        // Get real Everclear adapter
        everclearAdapter = IEverclearAdapter(EVERCLEAR_ADAPTER);

        // Set fee deadline to future
        feeDeadline = block.timestamp + 3600; // 1 hour from now

        // Deploy bridge implementation
        EverclearTokenBridge implementation = new EverclearTokenBridge(
            address(weth),
            1,
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );

        // Deploy proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(EverclearTokenBridge.initialize, (address(0), OWNER))
        );

        bridge = EverclearTokenBridge(address(proxy));

        // It would be great if we could mock the ecrecover function to always return the fee signer for the adapter
        // but we can't do that with forge. So we're going to sign the fee params with the fee signer private key
        // and set the fee signature to the signed message.
        // This is a bit of a hack, but it's the best we can do for now.
        // Change the fee signer on the Everclear adapter
        vm.prank(everclearAdapter.owner());
        (address _feeSigner, uint256 _feeSignerPrivateKey) = makeAddrAndKey(
            "feeSigner"
        );
        feeSigner = _feeSigner;
        everclearAdapter.updateFeeSigner(feeSigner);

        bytes32 _hash = keccak256(abi.encode(FEE_AMOUNT, 0, weth, feeDeadline));
        bytes32 _digest = ECDSA.toEthSignedMessageHash(_hash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            _feeSignerPrivateKey,
            _digest
        );
        feeSignature = abi.encodePacked(r, s, v);

        // Configure the bridge
        vm.startPrank(OWNER);
        bridge.setFeeParams(FEE_AMOUNT, feeDeadline, feeSignature);
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: OPTIMISM_DOMAIN,
                outputAsset: OUTPUT_ASSET
            })
        );
        bridge.enrollRemoteRouter(OPTIMISM_DOMAIN, RECIPIENT);
        vm.stopPrank();

        // Setup allowances
        vm.prank(ALICE);
        weth.approve(address(bridge), type(uint256).max);
    }

    function testFuzz_ForkTransferRemote(uint256 amount) public {
        // Fund Alice with WETH by wrapping ETH
        amount = bound(amount, 1, 100e6 ether);
        uint depositAmount = amount + FEE_AMOUNT;
        vm.deal(ALICE, depositAmount);
        vm.prank(ALICE);
        weth.deposit{value: depositAmount}();

        uint256 initialBalance = weth.balanceOf(ALICE);
        uint256 initialBridgeBalance = weth.balanceOf(address(bridge));

        // Test the transfer - it may succeed or fail depending on adapter state
        vm.prank(ALICE);
        // We don't want to check _intentId, as it's not used
        // It can be found by getting the fetching the spoke from the adapter with `IEverclearAdapter.spoke`,
        // fetching the intent queue with `SpokeStorage.intentQueue`
        // (see https://github.com/everclearorg/monorepo/blob/2c256760f338ded02dc58c4dee128135aff1d0e9/packages/contracts/src/contracts/intent/SpokeStorage.sol#L81)
        // and then calling `intentQueue.queue(intentQueue.last())`.
        vm.expectEmit(false, true, true, true);
        emit IEverclearAdapter.IntentWithFeesAdded({
            _intentId: bytes32(0),
            _initiator: address(bridge).addressToBytes32(),
            _tokenFee: FEE_AMOUNT,
            _nativeFee: 0
        });
        bridge.transferRemote(OPTIMISM_DOMAIN, RECIPIENT, amount);

        // Verify the balance changes
        // Alice should have lost the transfer amount and the fee
        assertEq(weth.balanceOf(ALICE), initialBalance - amount - FEE_AMOUNT);
        // The bridge forwards all weth to the adapter, so the bridge balance should be the same
        assertEq(weth.balanceOf(address(bridge)), initialBridgeBalance);
    }
}

/**
 * @notice Fork test contract for EverclearEthBridge on Arbitrum
 * @dev Tests the ETH bridge using real Arbitrum state and contracts with ETH transfers to Optimism
 * @dev Inherits from EverclearTokenBridgeForkTest to reuse setup logic
 * @dev We're running the cancun evm version, to avoid `NotActivated` errors
 * forge-config: default.evm_version = "cancun"
 */
contract EverclearEthBridgeForkTest is EverclearTokenBridgeForkTest {
    using TypeCasts for address;

    // ETH bridge contract
    EverclearEthBridge internal ethBridge;

    function setUp() public override {
        // Call parent setUp to initialize fork and all base contracts
        super.setUp();

        // Deploy ETH bridge implementation
        EverclearEthBridge implementation = new EverclearEthBridge(
            IWETH(ARBITRUM_WETH),
            1,
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );

        // Deploy proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(
                EverclearTokenBridge.initialize,
                (address(new TestPostDispatchHook()), OWNER)
            )
        );

        ethBridge = EverclearEthBridge(payable(address(proxy)));

        // Configure the ETH bridge using existing fee params and signature
        vm.startPrank(OWNER);
        ethBridge.setFeeParams(FEE_AMOUNT, feeDeadline, feeSignature);
        ethBridge.setOutputAsset(
            OutputAssetInfo({
                destination: OPTIMISM_DOMAIN,
                outputAsset: OUTPUT_ASSET
            })
        );
        ethBridge.enrollRemoteRouter(OPTIMISM_DOMAIN, RECIPIENT);
        vm.stopPrank();
    }

    function testFuzz_EthBridgeTransferRemote(uint256 amount) public {
        // Bound the amount to reasonable values
        amount = bound(amount, 1e15, 10e18); // 0.001 ETH to 10 ETH
        uint256 totalAmount = amount + FEE_AMOUNT;

        // Give Alice enough ETH
        vm.deal(ALICE, totalAmount);

        uint256 initialAliceBalance = ALICE.balance;
        uint256 initialBridgeBalance = weth.balanceOf(address(ethBridge));

        // Test the transfer - expect IntentWithFeesAdded event
        vm.prank(ALICE);
        vm.expectEmit(false, true, true, true);
        emit IEverclearAdapter.IntentWithFeesAdded({
            _intentId: bytes32(0),
            _initiator: address(ethBridge).addressToBytes32(),
            _tokenFee: FEE_AMOUNT,
            _nativeFee: 0
        });
        ethBridge.transferRemote{value: totalAmount}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        // Verify the balance changes
        // Alice should have lost the total ETH amount (amount + fee)
        assertEq(ALICE.balance, initialAliceBalance - totalAmount);
        // The bridge should not hold any WETH (it forwards to adapter)
        assertEq(weth.balanceOf(address(ethBridge)), initialBridgeBalance);
    }

    function testEthBridgeTransferRemoteInsufficientETH() public {
        uint256 amount = 1e18; // 1 ETH
        uint256 totalAmount = amount + FEE_AMOUNT;

        // Give Alice less ETH than needed
        vm.deal(ALICE, totalAmount - 1);

        vm.prank(ALICE);
        vm.expectRevert("EEB: ETH amount mismatch");
        ethBridge.transferRemote{value: totalAmount - 1}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );
    }

    function testEthBridgesendTokensFromIntent() public {
        uint256 amount = 1e18; // 1 ETH

        // Give the bridge some WETH
        vm.deal(address(ethBridge), amount);
        vm.prank(address(ethBridge));
        weth.deposit{value: amount}();

        // Mock the everclear spoke calling sendTokensFromIntent
        vm.prank(address(ethBridge.everclearSpoke()));

        uint256 initialBobBalance = BOB.balance;
        ethBridge.sendTokensFromIntent(RECIPIENT, amount);

        // Verify Bob received the ETH
        assertEq(BOB.balance, initialBobBalance + amount);
        // Verify the bridge no longer has WETH
        assertEq(weth.balanceOf(address(ethBridge)), 0);
    }

    function testEthBridgesendTokensFromIntentOnlyEverclearSpoke() public {
        uint256 amount = 1e18; // 1 ETH

        // Give the bridge some WETH
        vm.deal(address(ethBridge), amount);
        vm.prank(address(ethBridge));
        weth.deposit{value: amount}();

        // Try to call sendTokensFromIntent from a different address
        vm.prank(ALICE);
        vm.expectRevert("ETB: Only callable by EverclearSpoke");
        ethBridge.sendTokensFromIntent(RECIPIENT, amount);
    }

    function testEthBridgeQuoteTransferRemote() public {
        uint256 amount = 1e18; // 1 ETH

        Quote[] memory quotes = ethBridge.quoteTransferRemote(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, amount + FEE_AMOUNT);
    }

    function testEthBridgeReceiveFunction() public {
        uint256 amount = 1e18; // 1 ETH

        // Test that the bridge can receive ETH
        vm.deal(ALICE, amount);
        vm.prank(ALICE);
        (bool success, ) = address(ethBridge).call{value: amount}("");
        assertTrue(success);
        assertEq(address(ethBridge).balance, amount);
    }

    function testEthBridgeConstructor() public {
        EverclearEthBridge newBridge = new EverclearEthBridge(
            IWETH(ARBITRUM_WETH),
            1,
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );

        assertEq(address(newBridge.wrappedToken()), address(weth));
        assertEq(
            address(newBridge.everclearAdapter()),
            address(everclearAdapter)
        );
        assertEq(address(newBridge.token()), address(weth));
    }
}
