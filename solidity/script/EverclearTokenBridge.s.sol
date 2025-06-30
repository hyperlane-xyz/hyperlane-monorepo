// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, IEverclearAdapter} from "contracts/token/bridge/EverclearTokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {IWETH} from "contracts/token/interfaces/IWETH.sol";

import "forge-std/Script.sol";

contract EverclearTokenBridgeScript is Script {
    using TypeCasts for address;

    function run() public {
        address deployer = _getDeployer();
        vm.startBroadcast(deployer);

        // Deploy the bridge. This is an ARB eth bridge.
        EverclearTokenBridge bridge = new EverclearTokenBridge(
            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, // WETH
            1,
            0x979Ca5202784112f4738403dBec5D0F3B9daabB9, // Mailbox
            IEverclearAdapter(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75) // Everclear adapter
        );

        // Initialize the bridge
        bridge.initialize(address(0), address(0), deployer);

        // Set the output asset for the bridge.
        // This is optimism weth
        bridge.setOutputAsset(
            10,
            (0x4200000000000000000000000000000000000006).addressToBytes32()
        );

        // Set the fee params for the bridge.
        bridge.setFeeParams(
            1000000000000,
            1751851366,
            hex"4edddfdeabc459e3e9df4bc6807698e26443a663b3905c9b5d0f1054b4831b4616e89ff702f57e13d650331f11986ebe925ce497621b7f488c4672189b49b8e11c"
        );

        vm.stopBroadcast();
    }

    function depositEth() public {
        EverclearTokenBridge bridge = _getBridge();

        // Convert some eth to weth
        (uint256 fee, , ) = bridge.feeParams();
        uint256 amount = 0.0001 ether;
        uint256 totalAmount = amount + fee + 1;
        IWETH weth = IWETH(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
        weth.approve(address(bridge), type(uint256).max);
        weth.deposit{value: totalAmount}();
    }

    function sendIntent() public {
        address deployer = _getDeployer();
        vm.startBroadcast(deployer);

        EverclearTokenBridge bridge = _getBridge();

        depositEth();

        // Send a test intent
        bridge.transferRemote(10, deployer.addressToBytes32(), 0.0001 ether);

        vm.stopBroadcast();
    }

    function _getDeployer() internal returns (address) {
        return vm.rememberKey(vm.envUint("PRIVATE_KEY"));
    }

    function _getBridge() internal returns (EverclearTokenBridge) {
        return EverclearTokenBridge(0x02457BB8994C192F14d46568461E11723d169dB8);
    }
}
