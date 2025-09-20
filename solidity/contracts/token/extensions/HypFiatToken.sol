// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IFiatToken} from "../interfaces/IFiatToken.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

// see https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md#issuing-and-destroying-tokens
contract HypFiatToken is HypERC20Collateral {
    using TokenMessage for bytes;

    constructor(
        address _fiatToken,
        address _mailbox
    ) HypERC20Collateral(_fiatToken, 1, _mailbox) {}

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
        IFiatToken(address(wrappedToken)).burn(_amount);
        return messageId;
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        require(
            IFiatToken(address(wrappedToken)).mint(
                address(this),
                _message.amount()
            )
        );
        HypERC20Collateral._handle(_origin, _message);
    }
}
