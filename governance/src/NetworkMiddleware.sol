// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {INetworkRegistry} from "@symbiotic/interfaces/INetworkRegistry.sol";
import {INetworkMiddlewareService} from "@symbiotic/interfaces/service/INetworkMiddlewareService.sol";

import {IVault} from "@symbiotic/interfaces/vault/IVault.sol";
import {ISlasher} from "@symbiotic/interfaces/slasher/ISlasher.sol";

import {INetworkRestakeDelegator} from "@symbiotic/interfaces/delegator/INetworkRestakeDelegator.sol";

import {IDefaultStakerRewards} from "rewards/src/interfaces/defaultStakerRewards/IDefaultStakerRewards.sol";
import {IDefaultOperatorRewards} from "rewards/src/interfaces/defaultOperatorRewards/IDefaultOperatorRewards.sol";

contract Network {
    function register(
        INetworkRegistry networkRegistry,
        INetworkMiddlewareService middlewareService
    ) public {
        // prevents replays
        networkRegistry.registerNetwork();
        middlewareService.setMiddleware(msg.sender);
    }
}

contract NetworkMiddleware is Ownable {
    INetworkRegistry public networkRegistry;
    INetworkMiddlewareService public middlewareService;

    IVault public vault;
    IDefaultStakerRewards public stakerRewards;
    IDefaultOperatorRewards public operatorRewards;

    constructor(
        IVault _vault,
        IDefaultStakerRewards _stakerRewards,
        IDefaultOperatorRewards _operatorRewards
    ) Ownable(msg.sender) {
        vault = _vault;
        stakerRewards = _stakerRewards;
        operatorRewards = _operatorRewards;
    }

    function deployNetwork(uint32 domain) external returns (address network) {
        bytes32 salt = bytes32(uint256(domain));
        network = Create2.deploy(0, salt, type(Network).creationCode);
        Network(network).register(networkRegistry, middlewareService);
    }

    function getNetwork(uint32 domain) public view returns (address) {
        bytes32 salt = bytes32(uint256(domain));
        bytes32 bytecodeHash = keccak256(type(Network).creationCode);
        return Create2.computeAddress(salt, bytecodeHash);
    }

    // staking

    function allocateStake(
        uint32 domain,
        address validator,
        uint256 amount
    ) external onlyOwner {
        address network = getNetwork(domain);
        bytes32 subnetwork = bytes32(bytes20(network)); // why is this needed?
        INetworkRestakeDelegator(vault.delegator()).setOperatorNetworkShares(
            subnetwork,
            validator,
            amount
        );
    }

    // slashing

    function slash(
        uint32 domain,
        address validator,
        uint256 amount,
        uint48 timestamp
    ) external onlyOwner {
        address network = getNetwork(domain);
        bytes32 subnetwork = bytes32(bytes20(network)); // why is this needed?
        ISlasher(vault.slasher()).slash(
            subnetwork,
            validator,
            amount,
            timestamp,
            bytes("")
        );
    }

    // rewards

    function rewardStakers(uint32 domain, uint256 amount) external onlyOwner {
        address network = getNetwork(domain);
        address token = vault.collateral();
        stakerRewards.distributeRewards(network, token, amount, bytes(""));
    }

    function rewardOperators(
        uint32 domain,
        uint256 amount,
        bytes32 root
    ) external onlyOwner {
        address network = getNetwork(domain);
        address token = vault.collateral();
        operatorRewards.distributeRewards(network, token, amount, root);
    }
}
