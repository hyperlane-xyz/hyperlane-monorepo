// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {LiquidityLayerRouter} from "../contracts/middleware/liquidity-layer/LiquidityLayerRouter.sol";
import {CircleBridgeAdapter} from "../contracts/middleware/liquidity-layer/adapters/CircleBridgeAdapter.sol";
import {MockToken} from "../contracts/mock/MockToken.sol";
import {TestTokenRecipient} from "../contracts/test/TestTokenRecipient.sol";
import {MockCircleMessageTransmitter} from "../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleBridge} from "../contracts/mock/MockCircleBridge.sol";
import {MockHyperlaneEnvironment} from "../contracts/mock/MockHyperlaneEnvironment.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract LiquidityLayerRouterTest is Test {
    MockHyperlaneEnvironment testEnvironment;

    LiquidityLayerRouter originLiquidityLayerRouter;
    LiquidityLayerRouter destinationLiquidityLayerRouter;

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

    uint256 originInterchainGasPayment;

    event LiquidityLayerAdapterSet(string indexed bridge, address adapter);

    function setUp() public {
        token = new MockToken();

        circleBridge = new MockCircleBridge(token);
        messageTransmitter = new MockCircleMessageTransmitter(token);
        originBridgeAdapter = new CircleBridgeAdapter();
        destinationBridgeAdapter = new CircleBridgeAdapter();

        recipient = new TestTokenRecipient();

        originLiquidityLayerRouter = new LiquidityLayerRouter();
        destinationLiquidityLayerRouter = new LiquidityLayerRouter();

        testEnvironment = new MockHyperlaneEnvironment(
            originDomain,
            destinationDomain
        );

        originInterchainGasPayment = testEnvironment
            .igps(originDomain)
            .quoteGasPayment(
                destinationDomain,
                0 // For now, 0 gas is used
            );

        originLiquidityLayerRouter.initialize(
            address(testEnvironment.mailboxes(originDomain)),
            address(testEnvironment.igps(originDomain)),
            address(testEnvironment.isms(originDomain))
        );
        destinationLiquidityLayerRouter.initialize(
            address(testEnvironment.mailboxes(destinationDomain)),
            address(testEnvironment.igps(destinationDomain)),
            address(testEnvironment.isms(destinationDomain))
        );

        originLiquidityLayerRouter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationLiquidityLayerRouter))
        );
        destinationLiquidityLayerRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originLiquidityLayerRouter))
        );

        originBridgeAdapter.initialize(
            address(this),
            address(circleBridge),
            address(messageTransmitter),
            address(originLiquidityLayerRouter)
        );

        destinationBridgeAdapter.initialize(
            address(this),
            address(circleBridge),
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
            destinationDomain,
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
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
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
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testDispatchWithTokenTransfersMovesTokens() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
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
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testProcessingRevertsIfBridgeAdapterReverts() public {
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
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
        token.approve(address(originLiquidityLayerRouter), amount);
        originLiquidityLayerRouter.dispatchWithTokens{
            value: originInterchainGasPayment
        }(
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

    function testInsufficientInterchainGasPayment() public {
        token.approve(address(originLiquidityLayerRouter), amount);

        vm.expectRevert("insufficient interchain gas payment");
        originLiquidityLayerRouter.dispatchWithTokens{value: 0}(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            messageBody,
            address(token),
            amount,
            bridge
        );
    }
}
