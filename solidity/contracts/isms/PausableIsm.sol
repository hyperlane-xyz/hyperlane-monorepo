// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract PausableIsm is IInterchainSecurityModule, Ownable, Pausable {
    uint8 public constant override moduleType = uint8(Types.NULL);

    /**
     * @inheritdoc IInterchainSecurityModule
     * @dev Reverts when paused, otherwise returns `true`.
     */
    function verify(
        bytes calldata,
        bytes calldata
    ) external view whenNotPaused returns (bool) {
        return true;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
