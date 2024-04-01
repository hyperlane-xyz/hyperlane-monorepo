// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";

import "forge-std/console.sol";

contract RateLimitedHook is IPostDispatchHook, OwnableUpgradeable {
    using Message for bytes;
    using TokenMessage for bytes;
    using RateLimited for RateLimited.Limit;
    mapping(address hook => RateLimited.Limit) public limits;

    event RateLimitSet(address route, uint256 amount);
    error RateLimitExceeded();

    constructor() {
        _transferOwnership(msg.sender);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        // TODO write test
        return uint8(IPostDispatchHook.Types.UNUSED);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata) external pure returns (bool) {
        // TODO write test
        return false;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable {
        RateLimited.Limit storage limit = limits[
            TypeCasts.bytes32ToAddress(message.sender())
        ];
        uint256 amount = message.amount();
        console.log(limit.getCurrentLimitAmount());
        if (limit.current + amount > limit.getCurrentLimitAmount())
            revert RateLimitExceeded();
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }

    /**
     * Sets the max limit for a route address
     * @param route address to set
     * @param limit amount to set
     */
    function setLimitAmount(address route, uint256 limit) external onlyOwner {
        limits[route].setLimitAmount(limit);

        emit RateLimitSet(route, limit);
    }
}
