// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {GlobalHookMetadata} from "../libs/hooks/GlobalHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

contract PausableHook is IPostDispatchHook, Ownable, Pausable {
    using GlobalHookMetadata for bytes;

    // ============ Constants ============

    // The variant of the metadata used in the hook
    uint8 public constant METADATA_VARIANT = 1;

    // ============ External functions ============

    // @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata metadata)
        public
        pure
        override
        returns (bool)
    {
        return metadata.length == 0 || metadata.variant() == METADATA_VARIANT;
    }

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
