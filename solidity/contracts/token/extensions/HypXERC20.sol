// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20} from "../interfaces/IXERC20.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

contract HypXERC20 is HypERC20Collateral {
    constructor(
        address _xerc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_xerc20, _scale, _mailbox) {}

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        messageId = HypERC20Collateral.transferRemote(
            _destination,
            _recipient,
            _amount
        );
        IXERC20(address(wrappedToken)).burn(address(this), _amount);
        return messageId;
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        IXERC20(address(wrappedToken)).mint(address(this), _message.amount());
        HypERC20Collateral._handle(_origin, _message);
    }
}
