// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20} from "../interfaces/IXERC20.sol";
import {HypERC20} from "../HypERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

contract HypERC20Rebasing is HypERC20 {
    using Math for uint256;
    using Message for bytes;
    using TokenMessage for bytes;

    uint256 public constant PRECISION = 1e10;
    uint32 public immutable COLLATERAL_DOMAIN;
    uint256 public exchangeRate; // 1e10

    constructor(
        uint8 _decimals,
        address _mailbox,
        uint32 _collateralDomain
    ) HypERC20(_decimals, _mailbox) {
        COLLATERAL_DOMAIN = _collateralDomain;
        exchangeRate = 1e10;
        _disableInitializers();
    }

    // Override to send shares instead of assets from synthetic
    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        uint256 _shares = assetsToShares(_amountOrId);
        _transferFromSender(_shares);
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _shares,
            bytes("")
        );

        messageId = _Router_dispatch(
            _destination,
            _value,
            _tokenMessage,
            _hookMetadata,
            _hook
        );

        emit SentTransferRemote(_destination, _recipient, _amountOrId);
    }

    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override {
        uint256 _exchangeRate = abi.decode(_message.metadata(), (uint256));
        exchangeRate = _exchangeRate;
        super._handle(_origin, _sender, _message);
    }

    // Override so that we update the exchange rate
    // function _transferTo(
    //     address _recipient,
    //     uint256 _amount,
    //     bytes calldata metadata
    // ) internal virtual override {
    //     super._transferTo(_recipient, _amount, metadata);
    //     uint256 _exchangeRate = abi.decode(metadata, (uint256));
    //     exchangeRate = _exchangeRate;
    // }

    // Override to send shares locally instead of assets
    function transfer(
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, assetsToShares(amount));
        return true;
    }

    function shareBalanceOf(address account) public view returns (uint256) {
        return super.balanceOf(account);
    }

    function balanceOf(
        address account
    ) public view virtual override returns (uint256) {
        uint256 _balance = super.balanceOf(account);
        return sharesToAssets(_balance);
    }

    function assetsToShares(uint256 _amount) public view returns (uint256) {
        return _amount.mulDiv(PRECISION, exchangeRate);
    }

    function sharesToAssets(uint256 _shares) public view returns (uint256) {
        return _shares.mulDiv(exchangeRate, PRECISION);
    }
}
