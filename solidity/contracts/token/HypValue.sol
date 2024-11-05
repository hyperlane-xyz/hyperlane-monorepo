// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// Note: this assumes 1:1 exchange rate between source and destination chain
contract HypValue is TokenRouter {
    error InsufficientValue(uint256 amount, uint256 value);

    constructor(address _mailbox) TokenRouter(_mailbox) {}

    function initialize(
        address _valuehook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(
            _valuehook,
            _interchainSecurityModule,
            _owner
        );
    }

    // use _hook with caution
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _hookMetadata,
        address _hook
    ) public payable virtual override returns (bytes32 messageId) {
        uint256 quote = _checkSufficientValue(_destination, _amount);

        bytes memory hookMetadata = StandardHookMetadata.overrideMsgValue(
            _hookMetadata,
            _amount
        );

        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                _amount + quote,
                hookMetadata,
                _hook
            );
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual override returns (bytes32 messageId) {
        uint256 quote = _checkSufficientValue(_destination, _amount);
        bytes memory hookMetadata = StandardHookMetadata.formatMetadata(
            _amount,
            destinationGas[_destination],
            msg.sender,
            ""
        );

        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                _amount + quote,
                hookMetadata,
                address(hook)
            );
    }

    function _transferFromSender(
        uint256
    ) internal pure override returns (bytes memory) {
        return bytes(""); // no metadata
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    function balanceOf(
        address /* _account */
    ) external pure override returns (uint256) {
        return 0;
    }

    function _checkSufficientValue(
        uint32 _destination,
        uint256 _amount
    ) internal view returns (uint256) {
        uint256 quote = this.quoteGasPayment(_destination);
        if (msg.value < _amount + quote) {
            revert InsufficientValue(_amount + quote, msg.value);
        }
        return quote;
    }

    receive() external payable {}
}
