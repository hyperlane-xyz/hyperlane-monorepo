// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {TokenBridgeDepositAddress, DestinationConfig} from "../../contracts/token/bridge/TokenBridgeDepositAddress.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {MovableCollateralRouter} from "../../contracts/token/libs/MovableCollateralRouter.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";

contract TokenBridgeDepositAddressTest is Test {
    uint32 internal constant DOMAIN_ETH = 1;
    uint32 internal constant DOMAIN_ARB = 42161;
    uint256 internal constant FEE_BPS = 500;
    uint256 internal constant MAX_BPS = 10_000;

    ERC20Test internal token;
    TokenBridgeDepositAddress internal bridge;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    address internal depositAddress = makeAddr("deposit");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        token = new ERC20Test("MockUSDC", "mUSDC", 0, 6);
        bridge = new TokenBridgeDepositAddress(address(token), owner);

        vm.prank(owner);
        bridge.setDestinationConfig(
            DOMAIN_ARB,
            depositAddress,
            recipient,
            FEE_BPS
        );

        token.mintTo(caller, 1_000_000e6);
        vm.deal(caller, 10 ether);
        vm.prank(caller);
        token.approve(address(bridge), type(uint256).max);
    }

    function test_constructor_setsImmutables() public view {
        assertEq(bridge.token(), address(token));
        assertEq(bridge.owner(), owner);
    }

    function test_constructor_revertsOnInvalidToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeDepositAddress.InvalidToken.selector,
                address(0)
            )
        );
        new TokenBridgeDepositAddress(address(0), owner);
    }

    function test_setDestinationConfig() public {
        address newDepositAddress = makeAddr("newDeposit");
        bytes32 newRecipient = bytes32(
            uint256(uint160(makeAddr("newRecipient")))
        );

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TokenBridgeDepositAddress.DestinationConfigured(
            DOMAIN_ETH,
            newDepositAddress,
            newRecipient,
            700
        );
        bridge.setDestinationConfig(
            DOMAIN_ETH,
            newDepositAddress,
            newRecipient,
            700
        );

        DestinationConfig memory config = bridge.getDestinationConfig(
            DOMAIN_ETH,
            newRecipient
        );
        assertEq(config.depositAddress, newDepositAddress);
        assertEq(config.feeBps, 700);
    }

    function test_setDestinationConfig_revertsNonOwner() public {
        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.setDestinationConfig(DOMAIN_ETH, depositAddress, recipient, 0);
    }

    function test_setDestinationConfig_revertsOnInvalidFeeBps() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeDepositAddress.InvalidFeeBps.selector,
                MAX_BPS
            )
        );
        bridge.setDestinationConfig(
            DOMAIN_ETH,
            depositAddress,
            recipient,
            MAX_BPS
        );
    }

    function test_quoteTransferRemote() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ARB,
            recipient,
            100e6
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(token));
        assertEq(quotes[0].amount, 105e6);
    }

    function test_quoteTransferRemote_revertsOnMissingRecipient() public {
        bytes32 wrongRecipient = bytes32(
            uint256(uint160(makeAddr("wrongRecipient")))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeDepositAddress.RecipientNotConfigured.selector,
                DOMAIN_ARB,
                wrongRecipient
            )
        );
        bridge.quoteTransferRemote(DOMAIN_ARB, wrongRecipient, 100e6);
    }

    function test_transferRemote() public {
        uint256 amount = 100e6;
        uint256 feeAmount = (amount * FEE_BPS) / MAX_BPS;

        vm.prank(caller);
        bytes32 transferId = bridge.transferRemote(
            DOMAIN_ARB,
            recipient,
            amount
        );

        assertEq(transferId, bytes32(0));
        assertEq(token.balanceOf(depositAddress), amount + feeAmount);
        assertEq(token.balanceOf(address(bridge)), 0);
        assertEq(bridge.nonce(), 1);
    }

    function test_transferRemote_emitsEvent() public {
        uint256 amount = 100e6;
        uint256 feeAmount = (amount * FEE_BPS) / MAX_BPS;

        vm.prank(caller);
        vm.expectEmit(true, true, true, true);
        emit TokenBridgeDepositAddress.SentTransferRemoteViaDepositAddress(
            DOMAIN_ARB,
            recipient,
            depositAddress,
            amount,
            feeAmount,
            FEE_BPS
        );
        bridge.transferRemote(DOMAIN_ARB, recipient, amount);
    }

    function test_transferRemote_revertsOnNativeFee() public {
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeDepositAddress.NativeFeeNotSupported.selector,
                1
            )
        );
        bridge.transferRemote{value: 1}(DOMAIN_ARB, recipient, 100e6);
    }

    function test_removeDestinationConfig() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit TokenBridgeDepositAddress.DestinationRemoved(
            DOMAIN_ARB,
            recipient
        );
        bridge.removeDestinationConfig(DOMAIN_ARB, recipient);

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeDepositAddress.DestinationNotConfigured.selector,
                DOMAIN_ARB
            )
        );
        bridge.getDestinationConfig(DOMAIN_ARB, recipient);
    }

    function test_getDomainConfigs() public {
        bytes32 recipientTwo = bytes32(
            uint256(uint160(makeAddr("recipient2")))
        );
        bytes32 recipientThree = bytes32(
            uint256(uint160(makeAddr("recipient3")))
        );
        address depositAddressTwo = makeAddr("deposit2");
        address depositAddressThree = makeAddr("deposit3");

        vm.prank(owner);
        bridge.setDestinationConfig(
            DOMAIN_ETH,
            depositAddressTwo,
            recipientTwo,
            110
        );
        vm.prank(owner);
        bridge.setDestinationConfig(
            DOMAIN_ARB,
            depositAddressThree,
            recipientThree,
            210
        );

        (
            uint32[] memory domains,
            address[] memory depositAddresses,
            bytes32[] memory recipients,
            uint256[] memory feeBpsValues
        ) = bridge.getDomainConfigs();

        assertEq(domains.length, 3);
        assertEq(depositAddresses.length, 3);
        assertEq(recipients.length, 3);
        assertEq(feeBpsValues.length, 3);

        bool foundOriginal;
        bool foundEth;
        bool foundArb;
        for (uint256 i = 0; i < domains.length; i++) {
            if (
                domains[i] == DOMAIN_ARB &&
                depositAddresses[i] == depositAddress &&
                recipients[i] == recipient
            ) {
                assertEq(feeBpsValues[i], FEE_BPS);
                foundOriginal = true;
            } else if (
                domains[i] == DOMAIN_ETH &&
                depositAddresses[i] == depositAddressTwo &&
                recipients[i] == recipientTwo
            ) {
                assertEq(feeBpsValues[i], 110);
                foundEth = true;
            } else if (
                domains[i] == DOMAIN_ARB &&
                depositAddresses[i] == depositAddressThree &&
                recipients[i] == recipientThree
            ) {
                assertEq(feeBpsValues[i], 210);
                foundArb = true;
            }
        }

        assertTrue(foundOriginal);
        assertTrue(foundEth);
        assertTrue(foundArb);
    }

    function test_allowsMultipleRecipientsPerDomain() public {
        bytes32 recipientTwo = bytes32(
            uint256(uint160(makeAddr("recipient2")))
        );
        address depositAddressTwo = makeAddr("deposit2");

        vm.prank(owner);
        bridge.setDestinationConfig(
            DOMAIN_ARB,
            depositAddressTwo,
            recipientTwo,
            250
        );

        DestinationConfig memory configOne = bridge.getDestinationConfig(
            DOMAIN_ARB,
            recipient
        );
        DestinationConfig memory configTwo = bridge.getDestinationConfig(
            DOMAIN_ARB,
            recipientTwo
        );

        assertEq(configOne.depositAddress, depositAddress);
        assertEq(configOne.feeBps, FEE_BPS);
        assertEq(configTwo.depositAddress, depositAddressTwo);
        assertEq(configTwo.feeBps, 250);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ARB,
            recipientTwo,
            100e6
        );
        assertEq(quotes[0].amount, 102_500_000);
    }
}

contract TokenBridgeDepositAddressRebalanceTest is Test {
    uint32 internal constant ORIGIN_DOMAIN = 1;
    uint32 internal constant DESTINATION_DOMAIN = 42161;
    uint256 internal constant FEE_BPS = 100;

    ERC20Test internal token;
    HypERC20Collateral internal router;
    TokenBridgeDepositAddress internal bridge;
    MockMailbox internal mailbox;

    address internal depositAddress = makeAddr("deposit");
    address internal remoteRouter = makeAddr("remoteRouter");
    bytes32 internal remoteRecipient;

    function setUp() public {
        token = new ERC20Test("MockUSDC", "mUSDC", 0, 6);
        mailbox = new MockMailbox(ORIGIN_DOMAIN);
        router = new HypERC20Collateral(address(token), 1, 1, address(mailbox));
        router.initialize(address(0), address(0), address(this));

        bridge = new TokenBridgeDepositAddress(address(token), address(this));
        remoteRecipient = bytes32(uint256(uint160(remoteRouter)));

        router.enrollRemoteRouter(DESTINATION_DOMAIN, remoteRecipient);
        router.addRebalancer(address(this));
        router.addBridge(DESTINATION_DOMAIN, bridge);
        bridge.setDestinationConfig(
            DESTINATION_DOMAIN,
            depositAddress,
            remoteRecipient,
            FEE_BPS
        );
    }

    function test_rebalance_viaDepositAddressBridge() public {
        uint256 collateralAmount = 100e6;
        uint256 feeAmount = (collateralAmount * FEE_BPS) / 10_000;

        token.mintTo(address(router), collateralAmount);
        token.mintTo(address(this), feeAmount);
        token.approve(address(router), feeAmount);

        assertEq(router.allowedRecipient(DESTINATION_DOMAIN), bytes32(0));
        assertEq(
            token.allowance(address(router), address(bridge)),
            type(uint256).max
        );

        vm.expectEmit(true, true, true, true, address(bridge));
        emit TokenBridgeDepositAddress.SentTransferRemoteViaDepositAddress(
            DESTINATION_DOMAIN,
            remoteRecipient,
            depositAddress,
            collateralAmount,
            feeAmount,
            FEE_BPS
        );
        vm.expectEmit(true, true, true, true, address(router));
        emit MovableCollateralRouter.CollateralMoved(
            DESTINATION_DOMAIN,
            remoteRecipient,
            collateralAmount,
            address(this)
        );

        router.rebalance(DESTINATION_DOMAIN, collateralAmount, bridge);

        assertEq(token.balanceOf(depositAddress), collateralAmount + feeAmount);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(bridge)), 0);
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(bridge.nonce(), 1);
    }
}
