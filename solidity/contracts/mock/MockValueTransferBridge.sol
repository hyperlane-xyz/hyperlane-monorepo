// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockValueTransferBridge is ITokenBridge {
    using SafeERC20 for IERC20;
    address public collateral;

    constructor(address _collateral) {
        collateral = _collateral;
    }

    event SentTransferRemote(
        uint32 indexed origin,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    function quoteTransferRemote(
        uint32, //_destinationDomain,
        bytes32, //_recipient,
        uint256 //_amountOut
    ) public view virtual override returns (Quote[] memory) {
        Quote[] memory quotes = new Quote[](1);
        quotes[0] = Quote(collateral, 1);

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

        return keccak256("transferId");
    }
}
