// SPDX-License-Identifier: MIT OR Apache-2.0
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

// ============ Internal Imports ============
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract StaticAggregationHook is AbstractPostDispatchHook {
    using StandardHookMetadata for bytes;
    using Address for address payable;

    // ============ External functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.AGGREGATION);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        address[] memory _hooks = hooks(message);
        uint256 count = _hooks.length;
        uint256 gasRemaining = msg.value;
        for (uint256 i = 0; i < count; i++) {
            uint256 quote = IPostDispatchHook(_hooks[i]).quoteDispatch(
                metadata,
                message
            );

            gasRemaining -= quote;
            IPostDispatchHook(_hooks[i]).postDispatch{value: quote}(
                metadata,
                message
            );
        }

        if (gasRemaining > 0) {
            address payable refundAddress = payable(
                metadata.refundAddress(msg.sender)
            );
            refundAddress.sendValue(gasRemaining);
        }
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        address[] memory _hooks = hooks(message);
        uint256 count = _hooks.length;
        uint256 total = 0;
        for (uint256 i = 0; i < count; i++) {
            total += IPostDispatchHook(_hooks[i]).quoteDispatch(
                metadata,
                message
            );
        }
        return total;
    }

    function hooks(bytes calldata) public pure returns (address[] memory) {
        return abi.decode(MetaProxy.metadata(), (address[]));
    }
}
