// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {LiquidityLayerRouter} from "../contracts/middleware/liquidity-layer/LiquidityLayerRouter.sol";
import {CircleBridgeAdapter} from "../contracts/middleware/liquidity-layer/adapters/CircleBridgeAdapter.sol";
import {MockToken} from "../contracts/mock/MockToken.sol";
import {TestTokenRecipient} from "../contracts/test/TestTokenRecipient.sol";
import {TestRecipient} from "../contracts/test/TestRecipient.sol";
import {MockCircleMessageTransmitter} from "../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleTokenMessenger} from "../contracts/mock/MockCircleTokenMessenger.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract LiquidityLayerRouterTest is Test {
    MockHyperlaneEnvironment testEnvironment;

    LiquidityLayerRouter originLiquidityLayerRouter;
    LiquidityLayerRouter destinationLiquidityLayerRouter;

    MockCircleMessageTransmitter messageTransmitter;
    MockCircleTokenMessenger tokenMessenger;
    CircleBridgeAdapter originBridgeAdapter;
    CircleBridgeAdapter destinationBridgeAdapter;

    string bridge = "FooBridge";

    uint32 originDomain = 123;
    uint32 destinationDomain = 321;

    TestTokenRecipient recipient;
    MockToken token;
    bytes messageBody = hex"beefdead";
    uint256 amount = 420000;

    event LiquidityLayerAdapterSet(string indexed bridge, address adapter);

    function setUp() public {
        token = new MockToken();

        tokenMessenger = new MockCircleTokenMessenger(token);
        messageTransmitter = new MockCircleMessageTransmitter(token);

        recipient = new TestTokenRecipient();

        testEnvironment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );

        address originMailbox = address(
            testEnvironment.mailboxes(originDomain)
        );
        address destinationMailbox = address(
            testEnvironment.mailboxes(destinationDomain)
        );

        originBridgeAdapter = new CircleBridgeAdapter(originMailbox);
        destinationBridgeAdapter = new CircleBridgeAdapter(destinationMailbox);

        originLiquidityLayerRouter = new LiquidityLayerRouter(originMailbox);
        destinationLiquidityLayerRouter = new LiquidityLayerRouter(
            destinationMailbox
        );

        address owner = address(this);
        originLiquidityLayerRouter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationLiquidityLayerRouter))
        );
        destinationLiquidityLayerRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originLiquidityLayerRouter))
        );

        originBridgeAdapter.initialize(
            owner,
            address(tokenMessenger),
            address(messageTransmitter),
            address(originLiquidityLayerRouter)
        );

        destinationBridgeAdapter.initialize(
            owner,
            address(tokenMessenger),
            address(messageTransmitter),
            address(destinationLiquidityLayerRouter)
        );

        originBridgeAdapter.addToken(address(token), "USDC");
        destinationBridgeAdapter.addToken(address(token), "USDC");

        originBridgeAdapter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationBridgeAdapter))
        );
        destinationBridgeAdapter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originBridgeAdapter))
        );

        originLiquidityLayerRouter.setLiquidityLayerAdapter(
            bridge,
            address(originBridgeAdapter)
        );

        destinationLiquidityLayerRouter.setLiquidityLayerAdapter(
            bridge,
            address(destinationBridgeAdapter)
        );

        token.mint(address(this), amount);
    }

    function testSetLiquidityLayerAdapter() public {
        // Expect the LiquidityLayerAdapterSet event.
        // Expect topic0 & data to match
        vm.expectEmit(true, false, false, true);
        emit LiquidityLayerAdapterSet(bridge, address(originBridgeAdapter));

        // Set the token bridge adapter
        originLiquidityLayerRouter.setLiquidityLayerAdapter(
            bridge,
            address(originBridgeAdapter)
        );

        // Expect the bridge adapter to have been set
        assertEq(
            originLiquidityLayerRouter.liquidityLayerAdapters(bridge),
            address(originBridgeAdapter)
        );
    }

    // ==== dispatchWithTokens ====

    function testDispatchWithTokensRevertsWithUnkownBridgeAdapter() public {
        vm.expectRevert("No adapter found for bridge");
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            "BazBridge", // some unknown bridge name,
            messageBody
        );
    }

    function testDispatchWithTokensRevertsWithFailedTransferIn() public {
        vm.expectRevert("ERC20: insufficient allowance");
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            bridge,
            messageBody
        );
    }

    function testDispatchWithTokenTransfersMovesTokens() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            bridge,
            messageBody
        );
    }

    function testDispatchWithTokensCallsAdapter() public {
        vm.expectCall(
            address(originBridgeAdapter),
            abi.encodeWithSelector(
                originBridgeAdapter.sendTokens.selector,
                destinationDomain,
                TypeCasts.addressToBytes32(address(recipient)),
                address(token),
                amount
            )
        );
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            bridge,
            messageBody
        );
    }

    function testProcessingRevertsIfBridgeAdapterReverts() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            bridge,
            messageBody
        );

        vm.expectRevert("Circle message not processed yet");
        testEnvironment.processNextPendingMessage();
    }

    function testDispatchWithTokensTransfersOnDestination() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount,
            bridge,
            messageBody
        );

        bytes32 nonceId = messageTransmitter.hashSourceAndNonce(
            destinationBridgeAdapter.hyperlaneDomainToCircleDomain(
                originDomain
            ),
            tokenMessenger.nextNonce() - 1
        );

        messageTransmitter.process(
            nonceId,
            address(destinationBridgeAdapter),
            amount
        );
        testEnvironment.processNextPendingMessage();
        assertEq(recipient.lastData(), messageBody);
        assertEq(token.balanceOf(address(recipient)), amount);
    }

    function testCannotSendToRecipientWithoutHandle() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(this)),
            address(token),
            amount,
            bridge,
            messageBody
        );
        bytes32 nonceId = messageTransmitter.hashSourceAndNonce(
            destinationBridgeAdapter.hyperlaneDomainToCircleDomain(
                originDomain
            ),
            tokenMessenger.nextNonce() - 1
        );
        messageTransmitter.process(
            nonceId,
            address(destinationBridgeAdapter),
            amount
        );

        vm.expectRevert();
        testEnvironment.processNextPendingMessage();
    }

    function testSendToRecipientWithoutHandleWhenSpecifyingNoMessage() public {
        TestRecipient noHandleRecipient = new TestRecipient();
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(noHandleRecipient)),
            address(token),
            amount,
            bridge,
            ""
        );
        bytes32 nonceId = messageTransmitter.hashSourceAndNonce(
            destinationBridgeAdapter.hyperlaneDomainToCircleDomain(
                originDomain
            ),
            tokenMessenger.nextNonce() - 1
        );
        messageTransmitter.process(
            nonceId,
            address(destinationBridgeAdapter),
            amount
        );

        testEnvironment.processNextPendingMessage();
        assertEq(token.balanceOf(address(noHandleRecipient)), amount);
    }
}
