// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {IAbcToken} from "../interfaces/IAbcToken.sol";
// ============ External Imports ============
import {Router} from "@abacus-network/core/contracts/router/Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TransferRouter is Router {
    // The address of the token contract.
    IERC20 public token;

    constructor(address _token) {
        token = IERC20(_token);
    }

    error SenderNotToken();

    modifier onlyToken() {
        if (msg.sender != address(token)) {
            revert SenderNotToken();
        }
        _;
    }

    // Dispatches a message to a remote router to mint `amount` to `recipient`.
    function transferRemote(
        uint32 domain,
        address sender,
        address recipient,
        uint256 amount
    ) external onlyToken {}

    // Mints message.amount to message.recipient.
    function handleTransferMessage(bytes memory message) internal {}

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external override {

    }
}
