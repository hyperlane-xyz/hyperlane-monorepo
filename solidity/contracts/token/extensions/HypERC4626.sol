// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {HypERC20} from "../HypERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

/**
 * @title Hyperlane ERC20 Rebasing Token
 * @author Abacus Works
 * @notice This contract implements a rebasing token that reflects yields from the origin chain
 */
contract HypERC4626 is HypERC20 {
    using Math for uint256;
    using Message for bytes;
    using TokenMessage for bytes;

    uint256 public constant PRECISION = 1e10;
    uint32 public immutable collateralDomain;
    uint256 public exchangeRate; // 1e10

    constructor(
        uint8 _decimals,
        address _mailbox,
        uint32 _collateralDomain
    ) HypERC20(_decimals, _mailbox) {
        collateralDomain = _collateralDomain;
        exchangeRate = 1e10;
        _disableInitializers();
    }

    // ============ Public Functions ============

    /// Override transfer to handle underlying amounts while using shares internally
    /// @inheritdoc ERC20Upgradeable
    function transfer(
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, assetsToShares(amount));
        return true;
    }

    /// Override transferFrom to handle underlying amounts while using shares internally
    /// @inheritdoc ERC20Upgradeable
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public virtual override returns (bool) {
        address spender = _msgSender();
        uint256 shares = assetsToShares(amount);
        _spendAllowance(sender, spender, amount);
        _transfer(sender, recipient, shares);
        return true;
    }

    /// Override totalSupply to return the total assets instead of shares. This reflects the actual circulating supply in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function totalSupply() public view virtual override returns (uint256) {
        return sharesToAssets(super.totalSupply());
    }

    /// This returns the balance of the account in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function balanceOf(
        address account
    ) public view virtual override returns (uint256) {
        return sharesToAssets(super.balanceOf(account));
    }

    /// This function provides the total supply in terms of shares
    function totalShares() public view returns (uint256) {
        return super.totalSupply();
    }

    ///  This returns the balance of the account in terms of shares
    function shareBalanceOf(address account) public view returns (uint256) {
        return super.balanceOf(account);
    }

    function assetsToShares(uint256 _amount) public view returns (uint256) {
        return _amount.mulDiv(PRECISION, exchangeRate);
    }

    function sharesToAssets(uint256 _shares) public view returns (uint256) {
        return _shares.mulDiv(exchangeRate, PRECISION);
    }

    // ============ Internal Functions ============

    /// Override to send shares instead of assets from synthetic
    /// @inheritdoc TokenRouter
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

    /// override _handle to update exchange rate
    /// @inheritdoc TokenRouter
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override {
        if (_origin == collateralDomain) {
            exchangeRate = abi.decode(_message.metadata(), (uint256));
        }
        super._handle(_origin, _sender, _message);
    }

    /// override _transfer to handle share amounts internally but emit asset amounts
    /// @notice This maintains internal share-based accounting while providing asset-based transfer events
    /// @inheritdoc ERC20Upgradeable
    function _transfer(
        address sender,
        address recipient,
        uint256 amount
    ) internal virtual override {
        super._transfer(sender, recipient, amount);
        emit Transfer(sender, recipient, sharesToAssets(amount));
    }
}
