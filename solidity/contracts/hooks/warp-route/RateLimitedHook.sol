// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";

import "forge-std/console.sol";

contract RateLimitedHook is RateLimited, IPostDispatchHook, OwnableUpgradeable {
    using Message for bytes;
    using TokenMessage for bytes;

    error RateLimitExceeded();

    constructor() {
        _transferOwnership(msg.sender);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        // TODO write test?
        return uint8(IPostDispatchHook.Types.UNUSED);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata) external pure returns (bool) {
        // TODO write test?
        return false;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata,
        bytes calldata message
    ) external payable {
        address sender = TypeCasts.bytes32ToAddress(message.sender());
        RateLimited.Limit memory limit = limits[sender];
        uint256 amount = message.amount();
        if (limit.current + amount > getCurrentLimitAmount(sender))
            revert RateLimitExceeded();
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }
}
