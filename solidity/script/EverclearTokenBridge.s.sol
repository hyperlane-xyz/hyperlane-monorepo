// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, IEverclearAdapter} from "contracts/token/bridge/EverclearTokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import "forge-std/Script.sol";

contract EverclearTokenBridgeScript is Script {
    using TypeCasts for address;

    function run() public {
        vm.startBroadcast();

        // Deploy the bridge. This is an ARB eth bridge.
        EverclearTokenBridge bridge = new EverclearTokenBridge(
            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, // WETH
            1,
            0x979Ca5202784112f4738403dBec5D0F3B9daabB9, // Mailbox
            IEverclearAdapter(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75) // Everclear adapter
        );

        // Set the output asset for the bridge.
        // This is optimism weth
        bridge.setOutputAsset(
            10,
            (0x4200000000000000000000000000000000000006).addressToBytes32()
        );

        // Set the fee params for the bridge.
        bridge.setFeeParams(
            1000000000000,
            1751400919,
            hex"af569a125efdade92685ca6fef46c40d58ca3742611c6bff1f397cd59760660a51a55509c0fe75b0b7bc0eaa599a271087f5df70335b2a868b16e4ab969961671c"
        );

        vm.stopBroadcast();
    }
}
