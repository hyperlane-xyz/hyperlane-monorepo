// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {INetworkRegistry} from "@symbiotic/interfaces/INetworkRegistry.sol";
import {INetworkMiddlewareService} from "@symbiotic/interfaces/service/INetworkMiddlewareService.sol";

import {IVault} from "@symbiotic/interfaces/vault/IVault.sol";
import {ISlasher} from "@symbiotic/interfaces/slasher/ISlasher.sol";
import {IVetoSlasher} from "@symbiotic/interfaces/slasher/IVetoSlasher.sol";

import {INetworkRestakeDelegator} from "@symbiotic/interfaces/delegator/INetworkRestakeDelegator.sol";

import {IDefaultStakerRewards} from "rewards/src/interfaces/defaultStakerRewards/IDefaultStakerRewards.sol";
import {IDefaultOperatorRewards} from "rewards/src/interfaces/defaultOperatorRewards/IDefaultOperatorRewards.sol";

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

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
    using EnumerableSet for EnumerableSet.AddressSet;

    INetworkRegistry public immutable networkRegistry;
    INetworkMiddlewareService public immutable middlewareService;

    event NetworkDeployed(uint32 domain, address network);
    event VaultAuthorized(address vault);
    event VaultDeauthorized(address vault);

    EnumerableSet.AddressSet private vaults;

    IDefaultOperatorRewards public operatorRewards;

    constructor(IDefaultOperatorRewards _operatorRewards) Ownable(msg.sender) {
        operatorRewards = _operatorRewards;
    }

    modifier onlyAuthorized(address vault) {
        require(vaults.contains(vault), "unauthorized vault");
        _;
    }

    function authorizeVault(address vault) external onlyOwner {
        if (vaults.contains(vault)) {
            revert("Vault already authorized");
        }

        vaults.add(vault);
        emit VaultAuthorized(vault);
    }

    function deauthorizeVault(address vault) external onlyOwner {
        if (!vaults.contains(vault)) {
            revert("Vault not authorized");
        }

        vaults.remove(vault);
        emit VaultDeauthorized(vault);
    }

    function deployNetwork(uint32 domain) external returns (address network) {
        bytes32 salt = bytes32(uint256(domain));
        network = Create2.deploy(0, salt, _networkBytecode());
        emit NetworkDeployed(domain, network);
    }

    function getNetwork(uint32 domain) public view returns (address) {
        bytes32 salt = bytes32(uint256(domain));
        return Create2.computeAddress(salt, keccak256(_networkBytecode()));
    }

    /**
     * @notice Allocate amount of stake in vault to a validator for a domain
     * @param vault address of the vault (must be authorized)
     * @param domain Hyperlane domain of the network
     * @param validator address of the validator
     * @param amount amount of stake to allocate
     * @dev Only owner can call this function
     * @dev Assumes the delegator is a NetworkRestakeDelegator
     */
    function allocateStake(
        address vault,
        uint32 domain,
        address validator,
        uint256 amount
    ) external onlyOwner onlyAuthorized(vault) {
        INetworkRestakeDelegator(IVault(vault).delegator())
            .setOperatorNetworkShares(
                bytes32(bytes20(getNetwork(domain))),
                validator,
                amount
            );
    }

    /**
     * @notice Slash the amount of stake in vault from a validator for a domain
     * @param vault address of the vault (must be authorized)
     * @param domain Hyperlane domain of the network
     * @param validator address of the validator
     * @param amount amount of stake to slash
     * @param timestamp timestamp when the slashing condition was captured
     * @dev Only owner can call this function
     * @dev Assumes the slasher is an instant slasher
     */
    function slash(
        address vault,
        uint32 domain,
        address validator,
        uint256 amount,
        uint48 timestamp
    ) external onlyOwner onlyAuthorized(vault) {
        bytes32 network = bytes32(bytes20(getNetwork(domain)));
        ISlasher(IVault(vault).slasher()).slash(
            network,
            validator,
            amount,
            timestamp,
            new bytes(0)
        );
    }

    /**
     * @notice Reward the stakers of vault for a domain with pro-rata token amount
     * @param stakerRewards address of the staker rewards contract
     * @param domain Hyperlane domain of the network
     * @param token address of the token to reward
     * @param amount amount of token to reward
     */
    function rewardStakers(
        IDefaultStakerRewards stakerRewards,
        uint32 domain,
        address token,
        uint256 amount
    ) external onlyOwner onlyAuthorized(stakerRewards.VAULT()) {
        address network = getNetwork(domain);
        stakerRewards.distributeRewards(network, token, amount, bytes(""));
    }

    /**
     * @notice Reward the operators for a domain with arbitrary distribution of token amount in root
     * @param domain Hyperlane domain of the network
     * @param token address of the token to reward
     * @param amount amount of token to reward
     * @param root Merkle root of the distribution
     */
    function rewardOperators(
        uint32 domain,
        address token,
        uint256 amount,
        bytes32 root
    ) external onlyOwner {
        address network = getNetwork(domain);
        operatorRewards.distributeRewards(network, token, amount, root);
    }

    function _networkBytecode() internal view returns (bytes memory) {
        return
            abi.encodePacked(
                type(Network).creationCode,
                abi.encode(networkRegistry, middlewareService)
            );
    }
}
