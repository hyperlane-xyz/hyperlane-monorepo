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
import {HypERC20} from "../HypERC20.sol";
import {Message} from "../../libs/Message.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {Router} from "../../client/Router.sol";

// ============ External Imports ============
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Rebasing Token
 * @author Abacus Works
 * @notice This contract implements a rebasing token that reflects yields from the origin chain
 * @dev Messages contain amounts as shares of ERC4626 and exchange rate of assets per share.
 * @dev internal ERC20 balances storage mapping is in share units
 * @dev internal ERC20 allowances storage mapping is in asset units
 * @dev public ERC20 interface is in asset units
 */
contract HypERC4626 is ERC20Upgradeable, TokenRouter {
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
    ) TokenRouter(_scale, _mailbox) {
        collateralDomain = _collateralDomain;
        exchangeRate = 1e10;
        _disableInitializers();
    }

    /**
     * @notice Initializes the Hyperlane router, ERC20 metadata, and mints initial supply to deployer.
     * @param _totalSupply The initial supply of the token.
     * @param _name The name of the token.
     * @param _symbol The symbol of the token.
     */
    function initialize(
        uint256 _totalSupply,
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        // Initialize ERC20 metadata
        __ERC20_init(_name, _symbol);
        _mint(msg.sender, _totalSupply);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ============ Public Functions ============

    /// Override totalSupply to return the total assets instead of shares. This reflects the actual circulating supply in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function totalSupply() public view override returns (uint256) {
        return sharesToAssets(totalShares());
    }

    /// This returns the balance of the account in terms of assets, accounting for rebasing
    /// @inheritdoc ERC20Upgradeable
    function balanceOf(address account) public view override returns (uint256) {
        return sharesToAssets(shareBalanceOf(account));
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

    // @inheritdoc ERC20Upgradeable
    // @dev Amount specified by user is in assets, but the internal accounting is in shares
    function _transfer(
        address _from,
        address _to,
        uint256 _amount
    ) internal override {
        super._transfer(_from, _to, assetsToShares(_amount));
    }

    // `_inboundAmount` implementation reused from `TokenRouter` unchanged because message
    // accounting is in shares

    // ========== TokenRouter extensions ============
    /// @inheritdoc TokenRouter
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
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
        super._handle(_origin, _sender, _message);
    }

    function token() public view override returns (address) {
        return address(this);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Amount specified by the user is in assets, but the internal accounting is in shares
     */
    function _transferFromSender(uint256 _amount) internal override {
        _burn(msg.sender, assetsToShares(_amount));
    }

    function _transferTo(
        address _recipient,
        uint256 _shares
    ) internal override {
        _mint(_recipient, _shares);
    }

    // _transferTo implementation reused from HypERC20 unchanged because internal accounting is in shares

    /**
     * @inheritdoc TokenRouter
     * @dev Amount specified by user is in assets, but the message accounting is in shares
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view override returns (uint256) {
        return TokenRouter._outboundAmount(assetsToShares(_localAmount));
    }
}
