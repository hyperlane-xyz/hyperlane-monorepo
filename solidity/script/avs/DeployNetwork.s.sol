// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {ProxyAdmin} from "../../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../../contracts/upgrade/TransparentUpgradeableProxy.sol";

import {Network} from "./Network.sol";

contract DeployNetwork is Script {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    address networkRegistry = vm.envAddress("NETWORK_REGISTRY");

    address proxyAdmin = vm.envAddress("PROXY_ADMIN");
    address safe = vm.envAddress("SAFE");

    uint256 constant MIN_DELAY = 3 days;

    function run() external {
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        Network timelockImplementation = new Network();

        address[] memory proposers = new address[](2);
        proposers[0] = deployer;
        proposers[1] = safe;

        address[] memory executors = new address[](2);
        executors[0] = deployer;
        executors[1] = safe;

        address admin = safe;

        bytes memory initializeCall = abi.encodeCall(
            timelockImplementation.initialize,
            (0, proposers, executors, admin)
        );

        TransparentUpgradeableProxy timelockProxy = new TransparentUpgradeableProxy(
                address(timelockImplementation),
                proxyAdmin,
                initializeCall
            );

        Network timelock = Network(payable(timelockProxy));

        timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), safe);

        bytes memory registerNetworkCall = abi.encodeWithSignature(
            "registerNetwork()"
        );

        uint256 numCalls = 3;

        address[] memory targets = new address[](numCalls);
        uint256[] memory values = new uint256[](numCalls);
        bytes[] memory payloads = new bytes[](numCalls);

        targets[0] = networkRegistry;
        values[0] = 0;
        payloads[0] = registerNetworkCall;

        targets[1] = address(timelock);
        values[1] = 0;
        payloads[1] = abi.encodeCall(timelock.updateDelay, (MIN_DELAY));

        targets[2] = address(timelock);
        values[2] = 0;
        payloads[2] = abi.encodeCall(
            timelock.revokeRole,
            (timelock.PROPOSER_ROLE(), deployer)
        );

        timelock.scheduleBatch(
            targets,
            values,
            payloads,
            bytes32(0),
            bytes32(0),
            0
        );

        timelock.executeBatch(
            targets,
            values,
            payloads,
            bytes32(0),
            bytes32(0)
        );

        vm.stopBroadcast();

        assert(timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), safe));
        assert(!timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), deployer));

        assert(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assert(!timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));

        assert(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe));
        assert(timelock.hasRole(timelock.EXECUTOR_ROLE(), deployer));
    }
}
