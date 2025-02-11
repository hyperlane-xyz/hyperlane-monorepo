// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AmountPartition} from "../../token/libs/AmountPartition.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";

/**
 * @title AmountRoutingHook
 */
contract AmountRoutingHook is AmountPartition, AbstractPostDispatchHook {
    constructor(
        address _lowerHook,
        address _upperHook,
        uint256 _threshold
    ) AmountPartition(_lowerHook, _upperHook, _threshold) {}

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.AMOUNT_ROUTING);
    }

    function _postDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal override {
        uint256 quote = _quoteDispatch(_metadata, _message);
        IPostDispatchHook(_partition(_message)).postDispatch{value: quote}(
            _metadata,
            _message
        );
        return _refund(_metadata, _message, msg.value - quote);
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
