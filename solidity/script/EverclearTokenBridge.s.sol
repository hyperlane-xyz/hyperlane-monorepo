// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, IEverclearAdapter, OutputAssetInfo} from "contracts/token/bridge/EverclearTokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {IWETH} from "contracts/token/interfaces/IWETH.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "forge-std/Script.sol";

contract ScriptPlus is Script {
    mapping(string chainName => uint256 forkId) public forkIds;

    function createFork(string memory chainName) public {
        uint256 forkId = vm.createSelectFork(chainName);
        forkIds[chainName] = forkId;
    }
    function selectFork(string memory chainName) public {
        vm.selectFork(forkIds[chainName]);
    }
    function _start() internal returns (address) {
        address deployer = _getDeployer();
        vm.startBroadcast(deployer);
        return deployer;
    }
    function _getDeployer() internal returns (address) {
        address deployer = vm.rememberKey(vm.envUint("PRIVATE_KEY"));
        return deployer;
    }

    function _stop() internal {
        vm.stopBroadcast();
    }
}

contract EverclearTokenBridgeScript is ScriptPlus {
    using TypeCasts for address;

    function deployBridge() public returns (EverclearTokenBridge) {
        createFork("arbitrum");
        address deployer = _start();

        // Deploy the bridge. This is an ARB weth bridge.
        EverclearTokenBridge bridge = new EverclearTokenBridge(
            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, // WETH
            1, // Scale factor
            address(0x979Ca5202784112f4738403dBec5D0F3B9daabB9), // Mailbox
            IEverclearAdapter(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75) // Everclear adapter
        );

        // Initialize the bridge
        bridge.initialize(address(0), deployer);

        // Set the output asset for the bridge.
        // This is optimism weth
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: 10,
                outputAsset: (0x4200000000000000000000000000000000000006)
                    .addressToBytes32()
            })
        );

        // Set the fee params for the bridge.
        bridge.setFeeParams(
            1000000000000,
            1753302081,
            hex"706f864759e9315d1cc5303a8eb1b02e4e494b4bad9bf8602d5749fa5740ca9134fb2a071f891a35bb949e269f29d4972d2e424dfc2c439275ef8c5af67d82ca1b"
        );

        vm.stopBroadcast();

        return bridge;
    }

    function deployBridgeOptimism() public returns (EverclearTokenBridge) {
        createFork("optimism");
        address deployer = _start();

        // Deploy the bridge
        EverclearTokenBridge bridge = new EverclearTokenBridge(
            0x4200000000000000000000000000000000000006, // WETH
            1,
            0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D, // Mailbox
            IEverclearAdapter(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75) // Everclear adapter
        );

        // Initialize the bridge
        bridge.initialize(address(0), deployer);

        // Set the output asset for the bridge.
        // This is arbitrum weth
        bridge.setOutputAsset(
            OutputAssetInfo({
                destination: 42161,
                outputAsset: (0x82aF49447D8a07e3bd95BD0d56f35241523fBab1)
                    .addressToBytes32()
            })
        );

        // Set the fee params for the bridge
        // No signature for optimism yet
        bridge.setFeeParams(
            1000000000000,
            1753306369,
            hex"3f9a555cc805205c882e5ffba911b5c8427b4537b64b271d6af15ebf0e4e8eac6b0642f6ccc465649f41e85ce92b9bd26d0b20c4582be5807b9eb4e162d828e71b"
        );
        vm.stopBroadcast();

        return bridge;
    }

    function deploy() public {
        EverclearTokenBridge arbBridge = deployBridge();
        EverclearTokenBridge optimismBridge = deployBridgeOptimism();

        selectFork("arbitrum");
        _start();

        arbBridge.enrollRemoteRouter(
            10,
            address(optimismBridge).addressToBytes32()
        );
        vm.stopBroadcast();

        selectFork("optimism");
        _start();
        optimismBridge.enrollRemoteRouter(
            42161,
            address(arbBridge).addressToBytes32()
        );
        vm.stopBroadcast();
    }

    function depositEth(EverclearTokenBridge bridge) public {
        // Convert some eth to weth
        (uint256 fee, , ) = bridge.feeParams();
        uint256 amount = 0.0001 ether;
        uint256 totalAmount = amount + fee + 1;
        IWETH weth = IWETH(address(bridge.wrappedToken()));
        weth.approve(address(bridge), type(uint256).max);
        weth.deposit{value: totalAmount}();
    }

    function _sendIntent(EverclearTokenBridge bridge) internal {
        depositEth(bridge);
        // Send a test intent
        bridge.transferRemote(
            10,
            _getDeployer().addressToBytes32(),
            0.0001 ether
        );
    }

    function sendIntent() public {
        createFork("arbitrum");
        _start();
        EverclearTokenBridge arbBridge = EverclearTokenBridge(
            0x829F6EA418eafC9316Aa1A425fee8d77b0d6BADE
        );
        _sendIntent(arbBridge);
        _stop();
    }
}
