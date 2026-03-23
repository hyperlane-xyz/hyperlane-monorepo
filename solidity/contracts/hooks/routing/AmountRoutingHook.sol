// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AmountPartition} from "../../token/libs/AmountPartition.sol";

/**
 * @title AmountRoutingHook
 * @notice Routes to different child hooks based on the transfer amount in the message.
 * @dev Callers must use `quoteTransferRemote` with the actual transfer amount to get
 * an accurate fee quote. `GasRouter.quoteGasPayment(destination)` does not include the
 * amount and will not route to the correct child hook.
 */
contract AmountRoutingHook is AmountPartition, AbstractPostDispatchHook {
    constructor(
        address _lowerHook,
        address _upperHook,
        uint256 _threshold
    ) AmountPartition(_lowerHook, _upperHook, _threshold) {}

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.AMOUNT_ROUTING);
    }

    function _postDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal override {
        IPostDispatchHook(_partition(_message)).postDispatch{value: msg.value}(
            _metadata,
            _message
        );
    }

    function _quoteDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view override returns (uint256) {
        return
            IPostDispatchHook(_partition(_message)).quoteDispatch(
                _metadata,
                _message
            );
    }
}
