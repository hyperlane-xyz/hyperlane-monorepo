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
    constructor(
        INetworkRegistry networkRegistry,
        INetworkMiddlewareService middlewareService
    ) {
        networkRegistry.registerNetwork();
        middlewareService.setMiddleware(msg.sender);
    }
}

contract NetworkMiddleware is Ownable {
    INetworkRegistry public immutable networkRegistry;
    INetworkMiddlewareService public immutable middlewareService;

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

    function _bytecode() internal view returns (bytes memory) {
        return
            abi.encodePacked(
                type(Network).creationCode,
                abi.encode(networkRegistry, middlewareService)
            );
    }

    function deployNetwork(uint32 domain) external returns (address network) {
        bytes32 salt = bytes32(uint256(domain));
        network = Create2.deploy(0, salt, _bytecode());
    }

    function getNetwork(uint32 domain) public view returns (address) {
        bytes32 salt = bytes32(uint256(domain));
        return Create2.computeAddress(salt, keccak256(_bytecode()));
    }

    // staking

    function allocateStake(
        uint32 domain,
        address validator,
        uint256 amount
    ) external onlyOwner {
        INetworkRestakeDelegator(vault.delegator()).setOperatorNetworkShares(
            bytes32(bytes20(getNetwork(domain))),
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
        ISlasher(vault.slasher()).slash(
            bytes32(bytes20(getNetwork(domain))),
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
