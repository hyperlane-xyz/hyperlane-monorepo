// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {ProxyAdmin} from "../../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {TimelockControllerUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/TimelockControllerUpgradeable.sol";

contract TimelockControllerInitializer is TimelockControllerUpgradeable {
    function initialize(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) public initializer {
        __TimelockController_init(minDelay, proposers, executors, admin);
    }
}

contract DeployNetwork is Script {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

    address networkRegistry = 0xC773b1011461e7314CF05f97d95aa8e92C1Fd8aA;

    address proxyAdmin = 0x75EE15Ee1B4A75Fa3e2fDF5DF3253c25599cc659;
    address safe = 0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6;

    function run() external {
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        TimelockControllerInitializer timelockImplementation = new TimelockControllerInitializer();

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

        TimelockControllerInitializer timelock = TimelockControllerInitializer(
            payable(timelockProxy)
        );

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
        payloads[1] = abi.encodeCall(timelock.updateDelay, (1 days));

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
