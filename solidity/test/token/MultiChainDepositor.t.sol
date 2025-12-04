// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

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
import "forge-std/console.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {ERC4626Test} from "../../contracts/test/ERC4626/ERC4626Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";

import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {HypERC4626} from "../../contracts/token/extensions/HypERC4626.sol";
import {HypNative} from "../../contracts/token/HypNative.sol";
import {MultiChainDepositor} from "../../contracts/token/extensions/MultiChainDepositor.sol";
import {InterchainAccountRouter} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {OwnableMulticall} from "../../contracts/middleware/libs/OwnableMulticall.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {Message} from "../../contracts/libs/Message.sol";

contract MultiChainDepositorTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using Message for bytes;

    // Chain domains
    uint32 internal constant ARBITRUM_DOMAIN = 42161; // Origin chain
    uint32 internal constant ETHEREUM_DOMAIN = 1; // Yield chain
    uint32 internal constant INCENTIV_DOMAIN = 24101; // Destination chain (Incentiv)

    // Test addresses
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    uint256 internal constant TRANSFER_AMT = 100e6; // 100 USDC
    uint256 internal constant INITIAL_BALANCE = 1000e6; // 1000 USDC

    // Contract instances
    MockMailbox internal arbitrumMailbox;
    MockMailbox internal ethereumMailbox;
    MockMailbox internal incentivMailbox;

    ERC20Test internal usdcArbitrum;
    ERC20Test internal usdcEthereum;
    ERC4626Test internal yieldVault;
    ERC20Test internal yUSDC;

    HypERC20Collateral internal arbUsdcBridge;
    HypERC4626Collateral internal ethYieldBridge;
    HypNative internal arbNativeBridge;
    HypNative internal ethNativeBridge;
    HypERC4626 internal incentivYUsdcBridge;

    InterchainAccountRouter internal arbIcaRouter;
    InterchainAccountRouter internal ethIcaRouter;
    InterchainAccountRouter internal incentivIcaRouter;

    MultiChainDepositor internal depositor;
    TestPostDispatchHook internal noopHook;

    function setUp() public {
        // Deploy mailboxes
        arbitrumMailbox = new MockMailbox(ARBITRUM_DOMAIN);
        ethereumMailbox = new MockMailbox(ETHEREUM_DOMAIN);
        incentivMailbox = new MockMailbox(INCENTIV_DOMAIN);

        // Connect mailboxes for message routing
        arbitrumMailbox.addRemoteMailbox(ETHEREUM_DOMAIN, ethereumMailbox);
        arbitrumMailbox.addRemoteMailbox(INCENTIV_DOMAIN, incentivMailbox);
        ethereumMailbox.addRemoteMailbox(ARBITRUM_DOMAIN, arbitrumMailbox);
        ethereumMailbox.addRemoteMailbox(INCENTIV_DOMAIN, incentivMailbox);
        incentivMailbox.addRemoteMailbox(ARBITRUM_DOMAIN, arbitrumMailbox);
        incentivMailbox.addRemoteMailbox(ETHEREUM_DOMAIN, ethereumMailbox);

        // Deploy hooks
        noopHook = new TestPostDispatchHook();

        // Deploy tokens
        usdcArbitrum = new ERC20Test("USDC", "USDC", INITIAL_BALANCE * 10, 6);
        usdcEthereum = new ERC20Test("USDC", "USDC", INITIAL_BALANCE * 10, 6);
        yUSDC = new ERC20Test("yUSDC", "yUSDC", 0, 6);
        yieldVault = new ERC4626Test(
            address(usdcEthereum),
            "Yield USDC",
            "yUSDC"
        );

        // Deploy ICA routers for each chain
        string[] memory urls = new string[](1);
        urls[0] = "";

        arbIcaRouter = new InterchainAccountRouter(
            address(arbitrumMailbox),
            address(noopHook),
            address(this),
            50000,
            urls
        );

        ethIcaRouter = new InterchainAccountRouter(
            address(ethereumMailbox),
            address(noopHook),
            address(this),
            50000,
            urls
        );

        incentivIcaRouter = new InterchainAccountRouter(
            address(incentivMailbox),
            address(noopHook),
            address(this),
            50000,
            urls
        );

        // Enroll remote routers
        arbIcaRouter.enrollRemoteRouterAndIsm(
            ETHEREUM_DOMAIN,
            address(ethIcaRouter).addressToBytes32(),
            address(0).addressToBytes32()
        );
        arbIcaRouter.enrollRemoteRouterAndIsm(
            INCENTIV_DOMAIN,
            address(incentivIcaRouter).addressToBytes32(),
            address(0).addressToBytes32()
        );

        ethIcaRouter.enrollRemoteRouterAndIsm(
            ARBITRUM_DOMAIN,
            address(arbIcaRouter).addressToBytes32(),
            address(0).addressToBytes32()
        );
        ethIcaRouter.enrollRemoteRouterAndIsm(
            INCENTIV_DOMAIN,
            address(incentivIcaRouter).addressToBytes32(),
            address(0).addressToBytes32()
        );

        // Deploy token bridges
        arbUsdcBridge = new HypERC20Collateral(
            address(usdcArbitrum),
            1,
            address(arbitrumMailbox)
        );
        arbUsdcBridge.initialize(address(noopHook), address(0), address(this));

        arbNativeBridge = new HypNative(1, address(arbitrumMailbox));
        arbNativeBridge.initialize(
            address(noopHook),
            address(0),
            address(this)
        );

        ethNativeBridge = new HypNative(1, address(ethereumMailbox));
        ethNativeBridge.initialize(
            address(noopHook),
            address(0),
            address(this)
        );

        ethYieldBridge = new HypERC4626Collateral(
            yieldVault,
            1,
            address(ethereumMailbox)
        );
        ethYieldBridge.initialize(address(noopHook), address(0), address(this));

        incentivYUsdcBridge = new HypERC4626(
            6,
            1,
            address(incentivMailbox),
            ETHEREUM_DOMAIN
        );

        // Enroll remote routers for token bridges
        arbUsdcBridge.enrollRemoteRouter(
            ETHEREUM_DOMAIN,
            address(ethYieldBridge).addressToBytes32()
        );

        ethYieldBridge.enrollRemoteRouter(
            ARBITRUM_DOMAIN,
            address(arbUsdcBridge).addressToBytes32()
        );
        ethYieldBridge.enrollRemoteRouter(
            INCENTIV_DOMAIN,
            address(incentivYUsdcBridge).addressToBytes32()
        );

        incentivYUsdcBridge.enrollRemoteRouter(
            ETHEREUM_DOMAIN,
            address(ethYieldBridge).addressToBytes32()
        );

        // Enroll native bridge routers
        arbNativeBridge.enrollRemoteRouter(
            ETHEREUM_DOMAIN,
            address(ethNativeBridge).addressToBytes32()
        );

        ethNativeBridge.enrollRemoteRouter(
            ARBITRUM_DOMAIN,
            address(arbNativeBridge).addressToBytes32()
        );

        // Deploy MultiChainDepositor
        depositor = new MultiChainDepositor(
            ARBITRUM_DOMAIN,
            ETHEREUM_DOMAIN,
            INCENTIV_DOMAIN,
            address(arbUsdcBridge),
            address(ethYieldBridge),
            payable(address(arbNativeBridge)),
            payable(address(arbIcaRouter)),
            address(usdcEthereum)
        );

        // Setup initial balances
        usdcArbitrum.transfer(ALICE, INITIAL_BALANCE);
        vm.deal(ALICE, 10 ether);
        vm.deal(address(depositor), 10 ether);

        // Pre-populate the vault with USDC so the bridge has assets to redeem
        usdcEthereum.approve(address(yieldVault), INITIAL_BALANCE);
        yieldVault.deposit(INITIAL_BALANCE, address(ethYieldBridge));
    }

    function testDepositIntoVault() public {
        // Alice approves the depositor to spend USDC
        vm.startPrank(ALICE);
        usdcArbitrum.approve(address(depositor), TRANSFER_AMT);

        // Record initial balance
        uint256 aliceInitialBalance = usdcArbitrum.balanceOf(ALICE);
        assertEq(aliceInitialBalance, INITIAL_BALANCE);

        // Alice initiates deposit to yield vault
        uint256 gasPayment = 0.1 ether;
        uint256 yieldTransferGas = 100000;

        depositor.depositToYieldVault{value: gasPayment}(
            TRANSFER_AMT,
            BOB, // Final recipient on incentive chain
            yieldTransferGas
        );
        vm.stopPrank();

        // Verify USDC was transferred from Alice on Arbitrum
        assertEq(
            usdcArbitrum.balanceOf(ALICE),
            aliceInitialBalance - TRANSFER_AMT
        );

        // Process Arbitrum -> Ethereum messages
        // Get the ICA address on Ethereum
        address icaOnEthereum = arbIcaRouter.getRemoteInterchainAccount(
            ETHEREUM_DOMAIN,
            address(depositor)
        );

        // Process the USDC transfer message from Arbitrum to Ethereum ICA
        processNextMessage(ethereumMailbox);

        // Process the native token transfer message
        processNextMessage(ethereumMailbox);

        // Verify USDC arrived at ICA on Ethereum
        assertGt(
            usdcEthereum.balanceOf(icaOnEthereum),
            0,
            "ICA should have received USDC"
        );
        // Verify the ICA on Ethereum has received the native token
        assertEq(address(icaOnEthereum).balance, yieldTransferGas * 2);

        // Process ICA call message to execute on Ethereum
        processNextMessage(ethereumMailbox);

        // At this point, ICA should have:
        // 1. Approved yield vault bridge to spend USDC
        // 2. Called transferRemote on yield vault bridge to send yUSDC to incentive

        // Check that USDC was deposited into yield vault
        assertGt(
            yieldVault.balanceOf(address(ethYieldBridge)),
            0,
            "Yield vault should have received deposit"
        );

        // Process Ethereum -> Incentiv messages
        // Process the yUSDC transfer message from Ethereum to Incentiv
        processNextMessage(incentivMailbox);

        // Verify Bob received yUSDC on the incentiv chain
        console2.log("exchange rate", incentivYUsdcBridge.exchangeRate());
        assertEq(
            incentivYUsdcBridge.balanceOf(BOB),
            TRANSFER_AMT,
            "Bob should have received yUSDC on incentiv chain"
        );
    }

    function testDepositWithInsufficientBalance() public {
        vm.startPrank(ALICE);
        usdcArbitrum.approve(address(depositor), INITIAL_BALANCE + 1);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        depositor.depositToYieldVault{value: 0.1 ether}(
            INITIAL_BALANCE + 1,
            BOB,
            100000
        );
        vm.stopPrank();
    }

    function testDepositWithZeroAmount() public {
        vm.startPrank(ALICE);
        vm.expectRevert("Amount must be greater than 0");
        depositor.depositToYieldVault{value: 0.1 ether}(0, BOB, 100000);
        vm.stopPrank();
    }

    function testDepositWithInvalidRecipient() public {
        vm.startPrank(ALICE);
        usdcArbitrum.approve(address(depositor), TRANSFER_AMT);

        vm.expectRevert("Invalid recipient");
        depositor.depositToYieldVault{value: 0.1 ether}(
            TRANSFER_AMT,
            address(0),
            100000
        );
        vm.stopPrank();
    }

    function testQuoteDepositGasPayment() public {
        uint256 gasQuote = depositor.quoteDepositGasPayment();

        // Get individual component quotes
        uint256 usdcTransferGas = arbUsdcBridge.quoteGasPayment(
            ETHEREUM_DOMAIN
        );
        uint256 nativeTransferGas = arbNativeBridge.quoteGasPayment(
            ETHEREUM_DOMAIN
        );
        uint256 icaCallGas = arbIcaRouter.quoteGasPayment(ETHEREUM_DOMAIN);
        uint256 vaultSharesTransferGas = ethYieldBridge.quoteGasPayment(
            INCENTIV_DOMAIN
        );

        uint256 expectedTotal = usdcTransferGas +
            nativeTransferGas +
            icaCallGas +
            vaultSharesTransferGas;

        // Verify the quote equals sum of all component quotes (should be consistent)
        assertEq(
            gasQuote,
            expectedTotal,
            "Gas quote should equal sum of all component quotes"
        );
    }

    // Helper function to process messages
    function processNextMessage(MockMailbox mailbox) internal {
        // MockMailbox doesn't charge for processing, but we can provide some value
        mailbox.processNextInboundMessage{value: 0.01 ether}();
    }

    // Helper to process all pending messages on a mailbox
    function processAllMessages(MockMailbox mailbox) internal {
        while (
            mailbox.inboundUnprocessedNonce() > mailbox.inboundProcessedNonce()
        ) {
            processNextMessage(mailbox);
        }
    }
}
