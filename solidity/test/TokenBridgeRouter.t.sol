// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TokenBridgeRouter} from "../contracts/middleware/token-bridge/TokenBridgeRouter.sol";
import {CircleBridgeAdapter} from "../contracts/middleware/token-bridge/adapters/CircleBridgeAdapter.sol";
import {MockToken} from "../contracts/mock/MockToken.sol";
import {TestTokenRecipient} from "../contracts/test/TestTokenRecipient.sol";
import {MockCircleMessageTransmitter} from "../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleBridge} from "../contracts/mock/MockCircleBridge.sol";
import {MockHyperlaneEnvironment} from "./MockHyperlaneEnvironment.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract TokenBridgeRouterTest is Test {
    MockHyperlaneEnvironment testEnvironment;

    TokenBridgeRouter originTokenBridgeRouter;
    TokenBridgeRouter destinationTokenBridgeRouter;

    MockCircleMessageTransmitter messageTransmitter;
    MockCircleBridge circleBridge;
    CircleBridgeAdapter originBridgeAdapter;
    CircleBridgeAdapter destinationBridgeAdapter;

    string bridge = "FooBridge";

    uint32 originDomain = 123;
    uint32 destinationDomain = 321;

    TestTokenRecipient recipient;
    MockToken token;
    bytes messageBody = hex"beefdead";
    uint256 amount = 420000;

    event TokenBridgeAdapterSet(string indexed bridge, address adapter);

    function setUp() public {
        token = new MockToken();

        circleBridge = new MockCircleBridge(token);
        messageTransmitter = new MockCircleMessageTransmitter(token);
        originBridgeAdapter = new CircleBridgeAdapter();
        destinationBridgeAdapter = new CircleBridgeAdapter();

        recipient = new TestTokenRecipient();

        originTokenBridgeRouter = new TokenBridgeRouter();
        destinationTokenBridgeRouter = new TokenBridgeRouter();

        testEnvironment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );

        // TODO: set IGP?
        originTokenBridgeRouter.initialize(
            address(this),
            address(testEnvironment.connectionManager(originDomain)),
            address(0)
        );
        destinationTokenBridgeRouter.initialize(
            address(this),
            address(testEnvironment.connectionManager(destinationDomain)),
            address(0)
        );

        originTokenBridgeRouter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationTokenBridgeRouter))
        );
        destinationTokenBridgeRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originTokenBridgeRouter))
        );

        originBridgeAdapter.initialize(
            address(this),
            address(circleBridge),
            address(messageTransmitter),
            address(originTokenBridgeRouter)
        );

        destinationBridgeAdapter.initialize(
            address(this),
            address(circleBridge),
            address(messageTransmitter),
            address(destinationTokenBridgeRouter)
        );

        originBridgeAdapter.addToken(address(token), "USDC");
        destinationBridgeAdapter.addToken(address(token), "USDC");

        originBridgeAdapter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationBridgeAdapter))
        );
        destinationBridgeAdapter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(originBridgeAdapter))
        );

        originTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(originBridgeAdapter)
        );

        destinationTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(destinationBridgeAdapter)
        );

        token.mint(address(this), amount);
    }

    function testSetTokenBridgeAdapter() public {
        // Expect the TokenBridgeAdapterSet event.
        // Expect topic0 & data to match
        vm.expectEmit(true, false, false, true);
        emit TokenBridgeAdapterSet(bridge, address(originBridgeAdapter));

        // Set the token bridge adapter
        originTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(originBridgeAdapter)
        );

        // Expect the bridge adapter to have been set
        assertEq(
            originTokenBridgeRouter.tokenBridgeAdapters(bridge),
            address(originBridgeAdapter)
        );
    }

    // ==== dispatchWithTokens ====

    function testDispatchWithTokensRevertsWithUnkownBridgeAdapter() public {
        vm.expectRevert("No adapter found for bridge");
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            "BazBridge" // some unknown bridge name
        );
    }

    function testDispatchWithTokensRevertsWithFailedTransferIn() public {
        vm.expectRevert("ERC20: insufficient allowance");
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testDispatchWithTokenTransfersMovesTokens() public {
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
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
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testProcessingRevertsIfBridgeAdapterReverts() public {
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );

        vm.expectRevert("Circle message not processed yet");
        testEnvironment.processNextPendingMessage();
    }

    function testDispatchWithTokensTransfersOnDestination() public {
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );

        bytes32 nonceId = messageTransmitter.hashSourceAndNonce(
            destinationBridgeAdapter.hyperlaneDomainToCircleDomain(
                originDomain
            ),
            circleBridge.nextNonce()
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
}
