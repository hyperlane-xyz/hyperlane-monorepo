// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TokenBridgeRouter} from "../contracts/middleware/token-bridge/TokenBridgeRouter.sol";

contract TokenBridgeRouterTest is Test {
    TokenBridgeRouter tokenBridgeRouter;

    event TokenBridgeAdapterSet(string indexed bridge, address adapter);

    function setUp() public {
        tokenBridgeRouter = new TokenBridgeRouter();

        tokenBridgeRouter.initialize(address(this), address(1), address(2));
    }

    function testSetTokenBridgeAdapter() public {
        string memory _bridge = "FooBridge";
        address _bridgeAdapter = address(0xdeadbeef);

        // Expect the TokenBridgeAdapterSet event.
        // Expect topic0 & data to match
        vm.expectEmit(true, false, false, false);
        emit TokenBridgeAdapterSet(_bridge, _bridgeAdapter);

        // Set the token bridge adapter
        tokenBridgeRouter.setTokenBridgeAdapter(_bridge, _bridgeAdapter);

        // Expect the bridge adapter to have been set
        assertEq(
            tokenBridgeRouter.tokenBridgeAdapters(_bridge),
            _bridgeAdapter
        );
    }
}
