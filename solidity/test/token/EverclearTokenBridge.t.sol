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
import {MockEverclearAdapter} from "../../contracts/mock/MockEverclearAdapter.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {EverclearBridge, EverclearEthBridge, EverclearTokenBridge, OutputAssetInfo} from "../../contracts/token/bridge/EverclearTokenBridge.sol";
import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../contracts/interfaces/IEverclearAdapter.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {IWETH} from "contracts/token/interfaces/IWETH.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
    event FeeParamsUpdated(uint32 destination, uint256 fee, uint256 deadline);
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
            abi.encodeCall(EverclearBridge.initialize, (address(0), OWNER))
        );

        bridge = EverclearTokenBridge(address(proxy));
        // Setup initial state
        vm.startPrank(OWNER);
        bridge.setFeeParams(DESTINATION, FEE_AMOUNT, feeDeadline, feeSignature);
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: DESTINATION,
                outputAsset: OUTPUT_ASSET
            })
        );
        bridge.enrollRemoteRouter(ORIGIN, address(bridge).addressToBytes32());
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
        emit FeeParamsUpdated(DESTINATION, newFee, newDeadline);

        vm.prank(OWNER);
        bridge.setFeeParams(DESTINATION, newFee, newDeadline, newSig);

        (uint256 fee, uint256 deadline, bytes memory sig) = bridge.feeParams(
            DESTINATION
        );
        assertEq(fee, newFee);
        assertEq(deadline, newDeadline);
        assertEq(sig, newSig);
    }

    function testSetFeeParamsOnlyOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        bridge.setFeeParams(DESTINATION, FEE_AMOUNT, feeDeadline, feeSignature);
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

        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0); // Gas payment is 0 for test dispatch hooks
        assertEq(quotes[1].token, address(token));
        assertEq(quotes[1].amount, TRANSFER_AMT);
        assertEq(quotes[2].token, address(token));
        assertEq(quotes[2].amount, FEE_AMOUNT);
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
        assertEq(everclearAdapter.lastData(), "");

        // Check fee params
        (uint256 fee, uint256 deadline, bytes memory sig) = everclearAdapter
            .lastFeeParams();
        assertEq(fee, FEE_AMOUNT);
        assertEq(deadline, feeDeadline);
        assertEq(sig, feeSignature);
    }

    function testTransferRemoteWithFeeRecipient() public {
        // Create a LinearFee contract as the fee recipient
        // LinearFee(token, maxFee, halfAmount, owner)
        address feeCollector = makeAddr("feeCollector");
        LinearFee feeContract = new LinearFee(
            address(token),
            1e6, // maxFee
            TRANSFER_AMT / 2, // halfAmount
            feeCollector
        );

        // Set fee recipient to the LinearFee contract
        vm.prank(OWNER);
        bridge.setFeeRecipient(address(feeContract));

        uint256 initialAliceBalance = token.balanceOf(ALICE);
        uint256 initialFeeContractBalance = token.balanceOf(
            address(feeContract)
        );
        uint256 initialBridgeBalance = token.balanceOf(address(bridge));

        // Get the expected fee from the feeContract
        uint256 expectedFeeRecipientFee = feeContract
        .quoteTransferRemote(DESTINATION, RECIPIENT, TRANSFER_AMT)[0].amount;

        vm.prank(ALICE);
        bridge.transferRemote(DESTINATION, RECIPIENT, TRANSFER_AMT);

        // Check Alice paid the transfer amount + external fee + fee recipient fee
        assertEq(
            token.balanceOf(ALICE),
            initialAliceBalance -
                TRANSFER_AMT -
                FEE_AMOUNT -
                expectedFeeRecipientFee
        );

        // Check fee contract received the fee recipient fee (this tests the fix!)
        assertEq(
            token.balanceOf(address(feeContract)),
            initialFeeContractBalance + expectedFeeRecipientFee
        );

        // Check bridge only holds the transfer amount + external fee, not the fee recipient fee
        assertEq(
            token.balanceOf(address(bridge)),
            initialBridgeBalance + TRANSFER_AMT + FEE_AMOUNT
        );
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
        bridge.setFeeParams(DESTINATION, fee, deadline, feeSignature);

        (uint256 storedFee, uint256 storedDeadline, ) = bridge.feeParams(
            DESTINATION
        );
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
        uint256 tokenCost = quotes[1].amount;
        uint256 fee = quotes[2].amount;

        // 2. Execute transfer
        vm.prank(ALICE);
        bytes32 transferId = bridge.transferRemote(
            DESTINATION,
            RECIPIENT,
            transferAmount
        );

        // 3. Verify state changes
        assertEq(token.balanceOf(ALICE), initialAliceBalance - tokenCost - fee);

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

    // ============ IntentSettled Tests ============

    function testIntentSettledInitiallyFalse() public {
        // Create a mock intent
        IEverclear.Intent memory intent = IEverclear.Intent({
            initiator: bytes32(uint256(uint160(ALICE))),
            receiver: RECIPIENT,
            inputAsset: bytes32(uint256(uint160(address(token)))),
            outputAsset: bytes32(uint256(uint160(address(token)))),
            maxFee: 0,
            origin: ORIGIN,
            destinations: new uint32[](1),
            nonce: 1,
            timestamp: uint48(block.timestamp),
            ttl: 0,
            amount: 100e18,
            data: abi.encode(RECIPIENT, 100e18)
        });
        intent.destinations[0] = DESTINATION;

        bytes32 intentId = keccak256(abi.encode(intent));

        // Verify intent is not initially settled
        assertFalse(bridge.intentSettled(intentId));
    }
}

contract MockEverclearTokenBridge is EverclearTokenBridge {
    constructor(
        address _weth,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) EverclearTokenBridge(_weth, _scale, _mailbox, _everclearAdapter) {}

    bytes public lastIntent;

    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal override returns (IEverclear.Intent memory) {
        IEverclear.Intent memory intent = super._createIntent(
            _destination,
            _recipient,
            _amount
        );
        lastIntent = abi.encode(intent);
        return intent;
    }
}

contract BaseEverclearTokenBridgeForkTest is Test {
    using TypeCasts for *;
    using Message for bytes;

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
    address internal BOB = makeAddr("bob2");
    address internal OWNER = makeAddr("owner");
    address internal PROXY_ADMIN = makeAddr("proxyAdmin");

    // Contracts
    IWETH internal weth;
    IEverclearAdapter internal everclearAdapter;
    EverclearTokenBridge internal bridge;

    // Test data
    bytes32 internal constant OUTPUT_ASSET =
        bytes32(uint256(uint160(OPTIMISM_WETH)));
    bytes32 internal RECIPIENT = bytes32(uint256(uint160(BOB)));
    uint256 internal feeDeadline;
    address internal feeSigner;
    bytes internal feeSignature = hex"123f"; // We will create a real signature in setUp

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        return true;
    }

    function _deployBridge() internal virtual returns (address) {
        MockEverclearTokenBridge implementation = new MockEverclearTokenBridge(
            address(weth),
            1,
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );
        // Deploy proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(EverclearBridge.initialize, (address(0), OWNER))
        );

        return address(proxy);
    }

    function setUp() public virtual {
        // Fork Arbitrum at the latest block
        vm.createSelectFork("arbitrum");

        weth = IWETH(ARBITRUM_WETH);
        // Get real Everclear adapter
        everclearAdapter = IEverclearAdapter(EVERCLEAR_ADAPTER);

        // Set fee deadline to future
        feeDeadline = block.timestamp + 3600; // 1 hour from now

        // Deploy bridge
        bridge = EverclearTokenBridge(_deployBridge());

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

        // Configure the bridge. We can send to both Optimism and Arbitrum.
        vm.startPrank(OWNER);

        // Optimism
        bridge.setFeeParams(
            OPTIMISM_DOMAIN,
            FEE_AMOUNT,
            feeDeadline,
            feeSignature
        );
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: OPTIMISM_DOMAIN,
                outputAsset: OUTPUT_ASSET
            })
        );
        bridge.enrollRemoteRouter(
            OPTIMISM_DOMAIN,
            address(bridge).addressToBytes32()
        );

        // Arbitrum
        bridge.setFeeParams(
            ARBITRUM_DOMAIN,
            FEE_AMOUNT,
            feeDeadline,
            feeSignature
        );
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: ARBITRUM_DOMAIN,
                outputAsset: bytes32(uint256(uint160(ARBITRUM_WETH)))
            })
        );
        bridge.enrollRemoteRouter(
            ARBITRUM_DOMAIN,
            address(bridge).addressToBytes32()
        );
        // We will be the ism for this bridge
        bridge.setInterchainSecurityModule(address(this));
        vm.stopPrank();

        // Setup allowances
        vm.prank(ALICE);
        weth.approve(address(bridge), type(uint256).max);
    }
}

/**
 * @notice Fork test contract for EverclearTokenBridge on Arbitrum
 * @dev Tests the bridge using real Arbitrum state and contracts with WETH transfers to Optimism
 * @dev We're running the cancun evm version, to avoid `NotActivated` errors
 * forge-config: default.evm_version = "cancun"
 */
contract EverclearTokenBridgeForkTest is BaseEverclearTokenBridgeForkTest {
    using TypeCasts for *;

    function testFuzz_ForkTransferRemote(uint256 amount) public {
        // Fund Alice with WETH by wrapping ETH
        amount = bound(amount, 1, 100e6 ether);
        uint depositAmount = amount + FEE_AMOUNT;
        vm.deal(ALICE, depositAmount);
        vm.prank(ALICE);
        weth.deposit{value: depositAmount}();

        uint256 initialBalance = weth.balanceOf(ALICE);
        uint256 initialBridgeBalance = weth.balanceOf(address(bridge));

        // Get the gas payment quote
        Quote[] memory quotes = bridge.quoteTransferRemote(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );
        uint256 gasPayment = quotes[0].amount;

        // Give Alice ETH for gas payment
        vm.deal(ALICE, gasPayment);

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
        bridge.transferRemote{value: gasPayment}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        // Verify the balance changes
        // Alice should have lost the transfer amount and the fee
        assertEq(weth.balanceOf(ALICE), initialBalance - amount - FEE_AMOUNT);
        // The bridge forwards all weth to the adapter, so the bridge balance should be the same
        assertEq(weth.balanceOf(address(bridge)), initialBridgeBalance);
    }
}

contract MockEverclearEthBridge is EverclearEthBridge {
    constructor(
        IWETH _weth,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) EverclearEthBridge(_weth, _mailbox, _everclearAdapter) {}

    bytes public lastIntent;
    function _createIntent(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal override returns (IEverclear.Intent memory) {
        IEverclear.Intent memory intent = super._createIntent(
            _destination,
            _recipient,
            _amount
        );
        lastIntent = abi.encode(intent);
        return intent;
    }
}
/**
 * @notice Fork test contract for EverclearEthBridge on Arbitrum
 * @dev Tests the ETH bridge using real Arbitrum state and contracts with ETH transfers to Optimism
 * @dev Inherits from EverclearTokenBridgeForkTest to reuse setup logic
 * @dev We're running the cancun evm version, to avoid `NotActivated` errors
 * forge-config: default.evm_version = "cancun"
 */
contract EverclearEthBridgeForkTest is BaseEverclearTokenBridgeForkTest {
    using TypeCasts for address;
    using stdStorage for StdStorage;

    // ETH bridge contract
    MockEverclearEthBridge internal ethBridge;

    function _deployBridge() internal override returns (address) {
        // Deploy ETH bridge implementation
        MockEverclearEthBridge implementation = new MockEverclearEthBridge(
            IWETH(ARBITRUM_WETH),
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );

        // Deploy proxy
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(
                EverclearBridge.initialize,
                (address(new TestPostDispatchHook()), OWNER)
            )
        );
        return address(proxy);
    }

    function setUp() public override {
        super.setUp();
        ethBridge = MockEverclearEthBridge(payable(address(bridge)));
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
        vm.expectRevert("Native: amount exceeds msg.value");
        ethBridge.transferRemote{value: totalAmount - 1}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );
    }

    function testEthBridgeQuoteTransferRemote() public {
        uint256 amount = 1e18; // 1 ETH

        Quote[] memory quotes = ethBridge.quoteTransferRemote(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0);
        assertEq(quotes[1].token, address(0));
        assertEq(quotes[1].amount, amount);
        assertEq(quotes[2].token, address(0));
        assertEq(quotes[2].amount, FEE_AMOUNT);
    }

    function testEthBridgeConstructor() public {
        EverclearEthBridge newBridge = new EverclearEthBridge(
            IWETH(ARBITRUM_WETH),
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            everclearAdapter
        );

        assertEq(address(newBridge.wrappedToken()), address(weth));
        assertEq(
            address(newBridge.everclearAdapter()),
            address(everclearAdapter)
        );
        assertEq(address(newBridge.token()), address(0));
    }

    function testFork_receiveMessage(uint256 amount) public {
        amount = bound(amount, 1, 100e6 ether);
        uint depositAmount = amount + FEE_AMOUNT;
        vm.deal(ALICE, depositAmount);

        // Replace mailbox with code from MockMailbox
        MockMailbox _mailbox = new MockMailbox(ARBITRUM_DOMAIN);
        vm.etch(address(ethBridge.mailbox()), address(_mailbox).code);
        MockMailbox mailbox = MockMailbox(address(ethBridge.mailbox()));
        mailbox.addRemoteMailbox(ARBITRUM_DOMAIN, mailbox);

        // Actually sending message to arbitrum
        vm.prank(ALICE);
        ethBridge.transferRemote{value: depositAmount}(
            ARBITRUM_DOMAIN,
            RECIPIENT,
            amount
        );

        bytes32 intentId = keccak256(ethBridge.lastIntent());

        // Settle the created intent via direct storage write
        stdstore
            .target(address(ethBridge.everclearSpoke()))
            .sig(ethBridge.everclearSpoke().status.selector)
            .with_key(intentId)
            .checked_write(uint8(IEverclear.IntentStatus.SETTLED));

        assertEq(
            uint(ethBridge.everclearSpoke().status(intentId)),
            uint(IEverclear.IntentStatus.SETTLED)
        );

        // Give the bridge some WETH
        vm.deal(address(ethBridge), amount);
        vm.prank(address(ethBridge));
        weth.deposit{value: amount}();

        // Process the hyperlane message -> call handle directly
        // Deliver the message to the recipient.
        mailbox.processNextInboundMessage();

        // Funds should be sent to actual recipient
        assertEq(BOB.balance, amount);
    }

    // ============ intentSettled Mapping Tests ============

    function testIntentSettledInitiallyFalse() public {
        uint256 amount = 1e18; // 1 ETH
        uint256 totalAmount = amount + FEE_AMOUNT;

        // Fund Alice and perform a transfer to generate an intent
        vm.deal(ALICE, totalAmount);
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        // Get the intent ID from the last created intent
        bytes32 intentId = keccak256(ethBridge.lastIntent());

        // Verify intent is not initially settled in our bridge
        assertFalse(ethBridge.intentSettled(intentId));
    }

    function testIntentSettledAfterProcessing() public {
        uint256 amount = 1e18; // 1 ETH
        uint256 totalAmount = amount + FEE_AMOUNT;
        vm.deal(ALICE, totalAmount);

        // Setup mock mailbox for message processing
        MockMailbox _mailbox = new MockMailbox(ARBITRUM_DOMAIN);
        vm.etch(address(ethBridge.mailbox()), address(_mailbox).code);
        MockMailbox mailbox = MockMailbox(address(ethBridge.mailbox()));
        mailbox.addRemoteMailbox(ARBITRUM_DOMAIN, mailbox);

        // Perform transfer to create intent
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            ARBITRUM_DOMAIN,
            RECIPIENT,
            amount
        );

        bytes32 intentId = keccak256(ethBridge.lastIntent());

        // Initially should not be settled in our bridge
        assertFalse(ethBridge.intentSettled(intentId));

        // Settle the intent in Everclear spoke via storage manipulation
        stdstore
            .target(address(ethBridge.everclearSpoke()))
            .sig(ethBridge.everclearSpoke().status.selector)
            .with_key(intentId)
            .checked_write(uint8(IEverclear.IntentStatus.SETTLED));

        // Give the bridge some WETH to process the intent
        vm.deal(address(ethBridge), amount);
        vm.prank(address(ethBridge));
        weth.deposit{value: amount}();

        // Process the hyperlane message
        mailbox.processNextInboundMessage();

        // After processing, intent should be marked as settled in our bridge
        assertTrue(ethBridge.intentSettled(intentId));
    }

    function testIntentSettledPreventsDuplicateProcessing() public {
        uint amount = 1e18;
        testFork_receiveMessage(amount);
        // Try to process the same intent again - should fail because intent is already settled in our bridge
        MockMailbox mailbox = MockMailbox(address(ethBridge.mailbox()));
        bytes32 _recipient = address(ethBridge).addressToBytes32();
        bytes memory _message = TokenMessage.format(
            _recipient,
            amount,
            ethBridge.lastIntent()
        );
        bytes memory message = mailbox.buildMessage(
            address(ethBridge),
            ARBITRUM_DOMAIN,
            _recipient,
            _message
        );

        mailbox.addInboundMessage(message);
        vm.expectRevert("ETB: Intent already processed");
        mailbox.processNextInboundMessage();
    }

    function testFuzzIntentSettledWithVariousAmounts(uint256 amount) public {
        amount = bound(amount, 1e15, 10e18); // 0.001 ETH to 10 ETH
        uint256 totalAmount = amount + FEE_AMOUNT;

        vm.deal(ALICE, totalAmount);

        // Perform transfer
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        // Get intent ID and verify initially not settled
        bytes32 intentId = keccak256(ethBridge.lastIntent());
        assertFalse(ethBridge.intentSettled(intentId));

        // Verify intent ID is deterministic for same parameters
        vm.deal(ALICE, totalAmount);
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );

        bytes32 secondIntentId = keccak256(ethBridge.lastIntent());
        // Different intents should have different IDs (due to nonce/timestamp differences)
        assertTrue(intentId != secondIntentId);
        assertFalse(ethBridge.intentSettled(secondIntentId));
    }

    function testIntentSettledWithDifferentDestinations() public {
        uint256 amount = 1e18;
        uint256 totalAmount = amount + FEE_AMOUNT;

        // Configure bridge for Optimism transfers
        vm.prank(OWNER);
        ethBridge.enrollRemoteRouter(OPTIMISM_DOMAIN, RECIPIENT);

        vm.deal(ALICE, totalAmount * 2);

        // Transfer to Arbitrum
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            ARBITRUM_DOMAIN,
            RECIPIENT,
            amount
        );
        bytes32 arbitrumIntentId = keccak256(ethBridge.lastIntent());

        // Transfer to Optimism
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            OPTIMISM_DOMAIN,
            RECIPIENT,
            amount
        );
        bytes32 optimismIntentId = keccak256(ethBridge.lastIntent());

        // Both should be initially not settled and have different IDs
        assertFalse(ethBridge.intentSettled(arbitrumIntentId));
        assertFalse(ethBridge.intentSettled(optimismIntentId));
        assertTrue(arbitrumIntentId != optimismIntentId);
    }

    function testIntentSettledStatusChecking() public {
        uint256 amount = 1e18;
        uint256 totalAmount = amount + FEE_AMOUNT;
        vm.deal(ALICE, totalAmount);

        // Setup mock mailbox
        MockMailbox _mailbox = new MockMailbox(ARBITRUM_DOMAIN);
        vm.etch(address(ethBridge.mailbox()), address(_mailbox).code);
        MockMailbox mailbox = MockMailbox(address(ethBridge.mailbox()));
        mailbox.addRemoteMailbox(ARBITRUM_DOMAIN, mailbox);

        // Create intent
        vm.prank(ALICE);
        ethBridge.transferRemote{value: totalAmount}(
            ARBITRUM_DOMAIN,
            RECIPIENT,
            amount
        );

        bytes32 intentId = keccak256(ethBridge.lastIntent());

        // Try to process without settling in Everclear first - should fail
        vm.deal(address(ethBridge), amount);
        vm.prank(address(ethBridge));
        weth.deposit{value: amount}();

        vm.expectRevert("ETB: Intent Status != SETTLED");
        mailbox.processNextInboundMessage();

        // Verify still not settled in our bridge
        assertFalse(ethBridge.intentSettled(intentId));

        // Now settle in Everclear spoke
        stdstore
            .target(address(ethBridge.everclearSpoke()))
            .sig(ethBridge.everclearSpoke().status.selector)
            .with_key(intentId)
            .checked_write(uint8(IEverclear.IntentStatus.SETTLED));

        // Now processing should succeed
        mailbox.processNextInboundMessage();
        assertTrue(ethBridge.intentSettled(intentId));
    }
}
