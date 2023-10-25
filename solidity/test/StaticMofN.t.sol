// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {StaticOptimisticWatchersFactory} from "../contracts/isms/optimistic/StaticOptimisticWatchersFactory.sol";
import {StaticOptimisticWatchers} from "../contracts/isms/optimistic/StaticOptimisticWatchers.sol";

contract StaticOptimisticWatchersFactoryTest is Test {
    StaticOptimisticWatchersFactory factory;

    function setUp() public {
        factory = new StaticOptimisticWatchersFactory();
    }

    function test_1() external {
        console2.log("heloo");

        address[] memory watchers = new address[](3);
        watchers[0] = address(this);
        watchers[1] = address(this);
        watchers[2] = address(this);

        address deployResult = factory.deploy(watchers, 2);
        console2.log("deployResult", deployResult);

        StaticOptimisticWatchers addr = StaticOptimisticWatchers(address(factory.getAddress(watchers, 2)));
    

        // console2.log("addr", addr);

        (address[] memory watchers2, uint8 m) = addr.watchersAndThreshold(bytes(""));

    }
}