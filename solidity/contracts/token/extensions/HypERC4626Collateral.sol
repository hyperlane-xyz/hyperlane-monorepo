// SPDX-License-Identifier: Apache-2.0
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
import {TokenMessage} from "../libs/TokenMessage.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {FungibleTokenRouter} from "../libs/FungibleTokenRouter.sol";

// ============ External Imports ============
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import "forge-std/console.sol";

/**
 * @title Hyperlane ERC4626 Token Collateral with deposits collateral to a vault
 * @author Abacus Works
 */
contract HypERC4626Collateral is HypERC20Collateral {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Math for uint256;

    // Address of the ERC4626 compatible vault
    ERC4626 public immutable vault;
    // Precision for the exchange rate
    uint256 public constant PRECISION = 1e10;
    // Null recipient for rebase transfer
    bytes32 public constant NULL_RECIPIENT =
        0x0000000000000000000000000000000000000000000000000000000000000001;
    // Nonce for the rate update, to ensure sequential updates
    uint32 public rateUpdateNonce;

    constructor(
        ERC4626 _vault,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_vault.asset(), _scale, _mailbox) {
        vault = _vault;
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    /**
     * @inheritdoc FungibleTokenRouter
     * @dev
     */
    function _outboundAmount(
        uint256 _localAmount
    ) internal view virtual override returns (uint256) {
        uint256 shares = vault.convertToShares(_localAmount);
        console.log(shares);
        return FungibleTokenRouter._outboundAmount(shares);
    }

    /**
     * @inheritdoc HypERC20Collateral
     * @dev Extend ERC20 collateral `_transferFromSender` with deposit to vault.
     * @dev Append exchange rate (and nonce) to the message.
     */
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        HypERC20Collateral._transferFromSender(_amount);

        wrappedToken.approve(address(vault), _amount);
        // TODO: send this in the message rather than vault.convertToShares
        uint256 shares = vault.deposit(_amount, address(this));
        console.log(shares);

        uint256 _exchangeRate = vault.convertToAssets(PRECISION);
        rateUpdateNonce++;

        return abi.encode(_exchangeRate, rateUpdateNonce);
    }

    /**
     * @dev Withdraws `_shares` of `wrappedToken` from this contract to `_recipient`
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _shares,
        bytes calldata
    ) internal virtual override {
        vault.redeem(_shares, _recipient, address(this));
    }

    /**
     * @dev Update the exchange rate on the synthetic token by accounting for additional yield accrued to the underlying vault
     * @param _destinationDomain domain of the vault
     */
    function rebase(
        uint32 _destinationDomain,
        bytes calldata _hookMetadata,
        address _hook
    ) public payable {
        // force a rebase with an empty transfer to 0x1
        _transferRemote(
            _destinationDomain,
            NULL_RECIPIENT,
            0,
            msg.value,
            _hookMetadata,
            _hook
        );
    }
}
