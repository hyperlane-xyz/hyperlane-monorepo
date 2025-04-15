// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {TokenBridgeERC20} from "../TokenBridgeERC20.sol";
import {ITokenMessenger} from "../../interfaces/cctp/ITokenMessenger.sol";
import {IMessageTransmitter} from "../../interfaces/cctp/IMessageTransmitter.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";

contract TokenBridgeCctp is TokenBridgeERC20 {
    using TypeCasts for bytes32;

    uint32 public constant REMOTE_GAS_LIMIT = 200_000;

    constructor(
        address _erc20,
        address _mailbox
    ) TokenBridgeERC20(_erc20, _mailbox) {}

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);

        bytes memory tokenMessage = TokenMessage.format(
            _recipient,
            _amount,
            _getTokenMessageMetadata()
        );

        quotes[0] = Quote(
            address(0),
            _Router_quoteDispatch(
                _destination,
                tokenMessage,
                _getHookMetadata(),
                address(hook)
            )
        );
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        wrappedToken.transferFrom(msg.sender, address(hook), _amountOrId);
        return _getTokenMessageMetadata();
    }

    function _getTokenMessageMetadata() internal view returns (bytes memory) {
        return abi.encodePacked(wrappedToken);
    }

    function _getHookMetadata() internal view override returns (bytes memory) {
        return StandardHookMetadata.overrideGasLimit(REMOTE_GAS_LIMIT);
    }
}
