// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {StaticAggregationHook} from "../../contracts/hooks/aggregation/StaticAggregationHook.sol";
import {StaticAggregationHookFactory} from "../../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

contract AggregationHookTest is Test {
    StaticAggregationHookFactory internal factory;
    StaticAggregationHook internal hook;

    function setUp() public {
        factory = new StaticAggregationHookFactory();
    }

    function deployHooks(uint8 n) internal returns (address[] memory) {
        address[] memory hooks = new address[](n);
        for (uint8 i = 0; i < n; i++) {
            TestPostDispatchHook subHook = new TestPostDispatchHook();
            hooks[i] = address(subHook);
        }
        hook = StaticAggregationHook(factory.deploy(hooks));
        return hooks;
    }

    function testPostDispatch(uint8 _hooks) public {
        address[] memory hooksDeployed = deployHooks(_hooks);
        uint256 _msgValue = hooksDeployed.length * 25000;

        bytes memory message = abi.encodePacked("hello world");
        for (uint256 i = 0; i < hooksDeployed.length; i++) {
            vm.expectCall(
                hooksDeployed[i],
                25000,
                abi.encodeCall(
                    TestPostDispatchHook(hooksDeployed[i]).postDispatch,
                    ("", "hello world")
                )
            );
        }
        hook.postDispatch{value: _msgValue}("", message);
    }

    function testPostDispatch_reverts_outOfFund(uint8 _hooks, uint8 k) public {
        address[] memory hooksDeployed = deployHooks(_hooks);
        vm.assume(k < hooksDeployed.length);
        uint256 _msgValue = uint256(k) * 25000;

        bytes memory message = abi.encodePacked("hello world");
        for (uint256 i = 0; i < k; i++) {
            vm.expectCall(
                hooksDeployed[i],
                25000,
                abi.encodeCall(
                    TestPostDispatchHook(hooksDeployed[i]).postDispatch,
                    ("", "hello world")
                )
            );
        }
        vm.expectRevert(); // outOfFund
        hook.postDispatch{value: _msgValue}("", message);
    }

    function testQuoteDispatch(uint8 _hooks) public {
        address[] memory hooksDeployed = deployHooks(_hooks);
        uint256 _msgValue = hooksDeployed.length * 25000;

        bytes memory message = abi.encodePacked("hello world");
        uint256 totalQuote = hook.quoteDispatch("", message);

        assertEq(totalQuote, _msgValue);
    }

    function testMetadata(uint8 _hooks) public {
        address[] memory expectedHooks = deployHooks(_hooks);
        address[] memory actualHook = hook.hooks("");
        assertEq(actualHook, expectedHooks);
    }
}
