// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {IXERC20} from "../interfaces/IXERC20.sol";
import {HypERC20} from "../HypERC20.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {FungibleTokenRouter} from "../libs/FungibleTokenRouter.sol";

// ============ External Imports ============
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Rebasing Token
 * @author Abacus Works
 * @notice This contract implements a rebasing token that reflects yields from the origin chain
 * @dev Amounts in message and balance storage mapping are shares of the collateralizing ERC4626
 * @dev ERC20 internal accounting is in shares, but the public interface is in assets
        This includes `balanceOf`, `totalSupply`, `transfer`, `transferFrom`, and `approve`.
 */
contract HypERC4626 is HypERC20 {
    using Math for uint256;
    using Message for bytes;
    using TokenMessage for bytes;

    event ExchangeRateUpdated(uint256 newExchangeRate, uint32 rateUpdateNonce);

    uint256 public constant PRECISION = 1e10;
    uint32 public immutable collateralDomain;
    uint256 public exchangeRate; // 1e10
    uint32 public previousNonce;

    constructor(
        uint8 _decimals,
        uint256 _scale,
        address _mailbox,
        uint32 _collateralDomain
    ) HypERC20(_decimals, _scale, _mailbox) {
        collateralDomain = _collateralDomain;
        exchangeRate = 1e10;
        _disableInitializers();
    }

    // =========== ERC20 Public Interface ============

    /// Override totalSupply to return the total assets instead of shares. This reflects the actual circulating supply in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function totalSupply() public view virtual override returns (uint256) {
        return sharesToAssets(totalShares());
    }

    /// This returns the balance of the account in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function balanceOf(
        address account
    ) public view virtual override returns (uint256) {
        return sharesToAssets(shareBalanceOf(account));
    }

    /// This function provides the total supply in terms of shares
    function totalShares() public view returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    ///  This returns the balance of the account in terms of shares
    function shareBalanceOf(address account) public view returns (uint256) {
        return ERC20Upgradeable.balanceOf(account);
    }

    function assetsToShares(uint256 _amount) public view returns (uint256) {
        return _amount.mulDiv(PRECISION, exchangeRate);
    }

    function sharesToAssets(uint256 _shares) public view returns (uint256) {
        return _shares.mulDiv(exchangeRate, PRECISION);
    }

    // =========== ERC20 internal accounting ===========
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        ERC20Upgradeable._transfer(from, to, assetsToShares(amount));
    }

    function _spendAllowance(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual override {
        ERC20Upgradeable._spendAllowance(
            owner,
            spender,
            assetsToShares(amount)
        );
    }

    function _approve(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual override {
        ERC20Upgradeable._approve(owner, spender, assetsToShares(amount));
    }

    // @inheritdoc HypERC20
    // @dev Amount specified by the user is in assets, but the internal accounting is in shares
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        return HypERC20._transferFromSender(assetsToShares(_amount));
    }

    // @inheritdoc FungibleTokenRouter
    // @dev Amount specified by user is in assets, but the message accounting is in shares
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual override returns (uint256) {
        return
            FungibleTokenRouter._outboundAmount(assetsToShares(_localAmount));
    }

    // ========== TokenRouter extensions ============
    /// @inheritdoc TokenRouter
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override {
        if (_origin == collateralDomain) {
            (uint256 newExchangeRate, uint32 rateUpdateNonce) = abi.decode(
                _message.metadata(),
                (uint256, uint32)
            );
            // only update if the nonce is greater than the previous nonce
            if (rateUpdateNonce > previousNonce) {
                exchangeRate = newExchangeRate;
                previousNonce = rateUpdateNonce;
                emit ExchangeRateUpdated(exchangeRate, rateUpdateNonce);
            }
        }

        TokenRouter._handle(_origin, _sender, _message);
    }
}
