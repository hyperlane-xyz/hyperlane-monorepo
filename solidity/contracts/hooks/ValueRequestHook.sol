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
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/**
 * @title ValueRequestHook
 * @notice Hook that injects a configured msgValue into hook metadata for gas drop functionality.
 * @dev Immutable configuration - deploy a new instance to change the value.
 * @dev Composable with RoutingHook to configure different values per destination chain.
 */
contract ValueRequestHook is AbstractPostDispatchHook {
    using StandardHookMetadata for bytes;

    /// @notice The inner hook to delegate to after modifying metadata
    IPostDispatchHook public immutable innerHook;

    /// @notice The value to request for delivery on the destination chain
    uint256 public immutable value;

    /**
     * @notice Constructs the ValueRequestHook
     * @param _innerHook The hook to delegate to after modifying metadata
     * @param _value The value to request for delivery on the destination chain
     */
    constructor(address _innerHook, uint256 _value) {
        innerHook = IPostDispatchHook(_innerHook);
        value = _value;
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.VALUE_REQUEST);
    }

    /**
     * @notice Quotes the dispatch cost including the requested value
     * @param metadata The metadata provided by the caller
     * @param message The message being dispatched
     * @return The total cost: inner hook quote + requested value
     */
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        bytes memory newMetadata = _overrideMsgValue(metadata);
        return innerHook.quoteDispatch(newMetadata, message) + value;
    }

    /**
     * @notice Dispatches to the inner hook with modified metadata
     * @param metadata The metadata provided by the caller
     * @param message The message being dispatched
     */
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes memory newMetadata = _overrideMsgValue(metadata);
        innerHook.postDispatch{value: msg.value}(newMetadata, message);
    }

    /**
     * @notice Creates new metadata with the configured value injected
     * @param metadata The original metadata
     * @return New metadata with msgValue set to this hook's configured value
     */
    function _overrideMsgValue(
        bytes calldata metadata
    ) internal view returns (bytes memory) {
        return
            StandardHookMetadata.formatMetadata(
                value,
                metadata.gasLimit(0),
                metadata.refundAddress(address(0)),
                metadata.getCustomMetadata()
            );
    }
}
