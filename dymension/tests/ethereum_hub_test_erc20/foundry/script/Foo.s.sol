// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {Foo} from "../src/Foo.sol";

contract DeployFoo is Script {
    uint256 public constant INITIAL_SUPPLY = 1000000;

    function run() external {
        vm.startBroadcast();
        new Foo(INITIAL_SUPPLY);
        vm.stopBroadcast();
    }
}
