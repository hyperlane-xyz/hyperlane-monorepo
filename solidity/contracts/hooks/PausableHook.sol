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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
