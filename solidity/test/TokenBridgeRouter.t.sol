// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TokenBridgeRouter} from "../contracts/middleware/token-bridge/TokenBridgeRouter.sol";
import {MockToken} from "../contracts/mock/MockToken.sol";
import {MockTokenBridgeAdapter} from "../contracts/mock/MockTokenBridgeAdapter.sol";
import {HyperlaneTestHelper} from "./HyperlaneTestHelper.t.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract TokenBridgeRouterTest is Test, HyperlaneTestHelper {
    TokenBridgeRouter originTokenBridgeRouter;
    TokenBridgeRouter destinationTokenBridgeRouter;

    // Origin bridge adapter
    MockTokenBridgeAdapter bridgeAdapter;
    string bridge = "FooBridge";

    uint32 originDomain = 123;
    uint32 destinationDomain = 321;
    bytes32 recipient =
        0x00000000000000000000000000000000000000000000000000000000deadbeef;
    bytes messageBody = hex"beefdead";
    MockToken token;
    uint256 amount = 420000;

    event TokenBridgeAdapterSet(string indexed bridge, address adapter);

    function setUp() public {
        token = new MockToken();
        bridgeAdapter = new MockTokenBridgeAdapter();

        originTokenBridgeRouter = new TokenBridgeRouter();
        destinationTokenBridgeRouter = new TokenBridgeRouter();

        hyperlaneTestHelperSetUp(originDomain, destinationDomain);

        // TODO: set IGP?
        originTokenBridgeRouter.initialize(
            address(this),
            address(originManager),
            address(0)
        );
        destinationTokenBridgeRouter.initialize(
            address(this),
            address(destinationManager),
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

        originTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(bridgeAdapter)
        );

        destinationTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(bridgeAdapter)
        );

        token.mint(address(this), amount);
    }

    function testSetTokenBridgeAdapter() public {
        // Expect the TokenBridgeAdapterSet event.
        // Expect topic0 & data to match
        vm.expectEmit(true, false, false, true);
        emit TokenBridgeAdapterSet(bridge, address(bridgeAdapter));

        // Set the token bridge adapter
        originTokenBridgeRouter.setTokenBridgeAdapter(
            bridge,
            address(bridgeAdapter)
        );

        // Expect the bridge adapter to have been set
        assertEq(
            originTokenBridgeRouter.tokenBridgeAdapters(bridge),
            address(bridgeAdapter)
        );
    }

    // ==== dispatchWithTokens ====

    function testDispatchWithTokensRevertsWithUnkownBridgeAdapter() public {
        vm.expectRevert("!adapter");
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            recipient,
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
            recipient,
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testDispatchWithTokensTransfersTokensToAdapter() public {
        vm.expectCall(
            address(token),
            abi.encodeWithSelector(
                token.transferFrom.selector,
                address(this),
                address(bridgeAdapter),
                amount
            )
        );
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            recipient,
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
            recipient,
            messageBody,
            address(token),
            amount,
            bridge
        );
    }

    function testDispatchWithTokensCallsAdapter() public {
        vm.expectCall(
            address(bridgeAdapter),
            abi.encodeWithSelector(
                bridgeAdapter.bridgeToken.selector,
                destinationDomain,
                recipient,
                address(token),
                amount
            )
        );
        token.approve(address(originTokenBridgeRouter), amount);
        originTokenBridgeRouter.dispatchWithTokens(
            destinationDomain,
            recipient,
            messageBody,
            address(token),
            amount,
            bridge
        );
    }
}
