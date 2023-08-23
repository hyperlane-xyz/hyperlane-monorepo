// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {StaticAggregationHook} from "../../contracts/hooks/aggregation/StaticAggregationHook.sol";
import {StaticAggregationHookFactory} from "../../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

contract AggregationHookTest is Test {
    StaticAggregationHookFactory factory;
    StaticAggregationHook hook;

    function setUp() public {
        factory = new StaticAggregationHookFactory();
    }

    function deployHooks(uint8 n, bytes32 seed)
        internal
        returns (address[] memory)
    {
        bytes32 randomness = seed;
        address[] memory hooks = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            TestPostDispatchHook subHook = new TestPostDispatchHook();
            subHook.setRequiredMetadata(abi.encode(randomness));
            hooks[i] = address(subHook);
        }
        hook = StaticAggregationHook(factory.deploy(hooks));
        return hooks;
    }

    function getMetadata(bytes32 seed) private view returns (bytes memory) {
        address[] memory choices = hook.hooks("");
    }
}
