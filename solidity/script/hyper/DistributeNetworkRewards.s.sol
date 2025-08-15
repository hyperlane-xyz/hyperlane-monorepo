// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {ProxyAdmin} from "../../contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "../../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC4626Collateral} from "../../contracts/token/extensions/HypERC4626Collateral.sol";
import {IVault} from "../../contracts/interfaces/network/vault/IVault.sol";
import {ICompoundStakerRewards} from "../../contracts/interfaces/network/rewards/ICompoundStakerRewards.sol";
import {IDefaultStakerRewards} from "../../contracts/interfaces/network/rewards/IDefaultStakerRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INetworkRegistry} from "../../contracts/interfaces/network/INetworkRegistry.sol";
import {INetworkMiddlewareService} from "../../contracts/interfaces/network/service/INetworkMiddlewareService.sol";

import {Network} from "../avs/Network.sol";

contract DistributeNetworkRewards is Script {
    address networkMiddlewareService =
        vm.envAddress("NETWORK_MIDDLEWARE_SERVICE");
    address networkRegistry = vm.envAddress("NETWORK_REGISTRY");

    uint48 EPOCH_START = uint48(vm.envUint("EPOCH_START"));
    uint48 EPOCH_DURATION = uint48(vm.envUint("EPOCH_DURATION"));
    uint256 EPOCH_AMOUNT = vm.envUint("EPOCH_AMOUNT") * 10 ** 18;
    uint256 NUM_EPOCHS = vm.envUint("NUM_EPOCHS");

    address STAKED_WARP_ROUTE_ADDRESS =
        vm.envAddress("STAKED_WARP_ROUTE_ADDRESS");
    string STAKE_RPC_URL = vm.envString("STAKE_RPC_URL");

    HypERC20 public collateral;
    HypERC4626Collateral public stakedCollateral;
    IVault public vault;
    IDefaultStakerRewards public rewards;

    function run() external {
        address sender = msg.sender;

        vm.createSelectFork(STAKE_RPC_URL);

        stakedCollateral = HypERC4626Collateral(STAKED_WARP_ROUTE_ADDRESS);
        ICompoundStakerRewards compoundStakerRewards = ICompoundStakerRewards(
            address(stakedCollateral.vault())
        );
        rewards = IDefaultStakerRewards(
            address(compoundStakerRewards.rewards())
        );
        vault = compoundStakerRewards.vault();

        collateral = HypERC20(vault.collateral());

        // sender will be network
        address networkAddress = sender;

        vm.startBroadcast(sender);

        // 1. register network
        INetworkRegistry(networkRegistry).registerNetwork();

        // 2. set middleware to self
        INetworkMiddlewareService(networkMiddlewareService).setMiddleware(
            networkAddress
        );

        uint256 stakeAmount = NUM_EPOCHS * EPOCH_AMOUNT;

        // 3. approve hyper to vault
        collateral.approve(address(vault), stakeAmount);

        // 4. deposit hyper to vault
        vault.deposit(networkAddress, stakeAmount);

        // 5. approve stHYPER to rewards
        IERC20(address(vault)).approve(address(rewards), stakeAmount);

        // 6. distribute stHYPER rewards
        for (uint48 i = 0; i < NUM_EPOCHS; i++) {
            uint48 timestamp = EPOCH_START + EPOCH_DURATION * (i + 1);

            bytes memory data = abi.encode(
                timestamp,
                uint256(0), // maxAdminFee
                bytes(""), // activeSharesHint
                bytes("") // activeStakeHint
            );

            rewards.distributeRewards(
                networkAddress,
                address(vault),
                EPOCH_AMOUNT,
                data
            );
        }

        vm.stopBroadcast();
    }
}
