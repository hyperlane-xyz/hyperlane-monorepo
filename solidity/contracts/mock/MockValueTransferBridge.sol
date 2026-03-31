// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {Router} from "../client/Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Test} from "../test/ERC20Test.sol";

contract MockValueTransferBridge is Router, ITokenBridge {
    using SafeERC20 for IERC20;
    address public immutable collateral;

    event SentTransferRemote(
        uint32 indexed origin,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    constructor(address _collateral, address _mailbox) Router(_mailbox) {
        collateral = _collateral;
    }

    function initialize(
        address _hook,
        address _ism,
        address _owner
    ) external initializer {
        _MailboxClient_initialize(_hook, _ism, _owner);
    }

    function quoteTransferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amountOut
    ) public view virtual override returns (Quote[] memory) {
        uint256 dispatchFee = _Router_quoteDispatch(
            _destinationDomain,
            abi.encode(_recipient, _amountOut)
        );

        Quote[] memory quotes = new Quote[](2);
        quotes[0] = Quote(collateral, 1);
        quotes[1] = Quote(address(0), dispatchFee);
        return quotes;
    }

    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amountOut
    ) external payable virtual override returns (bytes32 transferId) {
        // Pull tokens from caller (warp token) - caller must have approved this bridge
        IERC20(collateral).safeTransferFrom(
            msg.sender,
            address(this),
            _amountOut
        );

        emit SentTransferRemote(
            uint32(block.chainid),
            _destinationDomain,
            _recipient,
            _amountOut
        );

        // Dispatch through MockMailbox so Dispatch event is emitted
        transferId = _Router_dispatch(
            _destinationDomain,
            msg.value,
            abi.encode(_recipient, _amountOut)
        );
    }

    function _handle(
        uint32, // _origin
        bytes32, // _sender
        bytes calldata _message
    ) internal virtual override {
        (bytes32 recipientBytes32, uint256 amount) = abi.decode(
            _message,
            (bytes32, uint256)
        );
        address recipient = address(uint160(uint256(recipientBytes32)));
        // Mint collateral tokens to recipient (destination warp token)
        ERC20Test(collateral).mintTo(recipient, amount);
    }
}
