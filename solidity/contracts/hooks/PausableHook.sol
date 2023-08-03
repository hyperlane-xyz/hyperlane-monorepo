// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {AbstractHook} from "./AbstractHook.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

contract PausableHook is AbstractHook, Ownable, Pausable {
    constructor(address _mailbox) AbstractHook(_mailbox) {}

    function _postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) internal view override whenNotPaused returns (address[] memory) {
        return new address[](0);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
