// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

contract PausableHook is IPostDispatchHook, Ownable, Pausable {
    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
        whenNotPaused
    {}

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(bytes calldata, bytes calldata)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
