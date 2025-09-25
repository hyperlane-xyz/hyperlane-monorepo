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
import {TokenRouter} from "../libs/TokenRouter.sol";
import {ERC20Collateral} from "../libs/TokenCollateral.sol";
import {LpCollateralRouterStorage} from "../libs/LpCollateralRouter.sol";

// ============ External Imports ============
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Hyperlane ERC4626 Token Collateral with deposits collateral to a vault
 * @author Abacus Works
 */
contract HypERC4626Collateral is TokenRouter {
    using ERC20Collateral for IERC20;
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Math for uint256;

    // Address of the ERC4626 compatible vault
    ERC4626 public immutable vault;
    IERC20 public immutable wrappedToken;

    // Precision for the exchange rate
    uint256 public constant PRECISION = 1e10;
    // Null recipient for rebase transfer
    bytes32 public constant NULL_RECIPIENT =
        0x0000000000000000000000000000000000000000000000000000000000000001;

    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

    // Nonce for the rate update, to ensure sequential updates
    uint32 public rateUpdateNonce;

    constructor(
        ERC4626 _vault,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        vault = _vault;
        wrappedToken = IERC20(_vault.asset());
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        wrappedToken.approve(address(vault), type(uint256).max);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to deposit tokens into the vault and add exchange rate metadata.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        // Don't use HypERC4626Collateral's implementation of _transferTo since it does a redemption.
        uint256 feeRecipientFee = _feeRecipientAmount(
            _destination,
            _recipient,
            _amount
        );
        uint256 externalFee = _externalFeeAmount(
            _destination,
            _recipient,
            _amount
        );
        _transferFromSender(_amount + feeRecipientFee);
        if (feeRecipientFee > 0) {
            wrappedToken._transferTo(feeRecipient(), feeRecipientFee);
        }

        // 2. Prepare the token message with the recipient, amount, and any additional metadata in overrides
        // Deposit the amount into the vault and get the shares for the TokenMessage amount
        uint256 _shares = _depositIntoVault(_amount);

        uint256 _exchangeRate = vault.convertToAssets(PRECISION);

        rateUpdateNonce++;
        bytes memory _tokenMetadata = abi.encode(
            _exchangeRate,
            rateUpdateNonce
        );

        uint256 _outboundAmount = _outboundAmount(_shares);
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _outboundAmount,
            _tokenMetadata
        );

        // 3. Emit the SentTransferRemote event and 4. dispatch the message
        return
            _emitAndDispatch(
                _destination,
                _recipient,
                _amount,
                msg.value,
                _tokenMessage
            );
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Withdraws `_shares` of `wrappedToken` from this contract to `_recipient`
     */
    // solhint-disable-next-line hyperlane/no-virtual-override
    function _transferTo(
        address _recipient,
        uint256 _shares
    ) internal virtual override {
        vault.redeem(_shares, _recipient, address(this));
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken._transferFromSender(_amount);
    }

    /**
     * @param _amount amount to deposit into vault
     * @dev Deposits into the vault and increment assetDeposited.
     * Known overrides:
     * - HypERC4626OwnerCollateral: Tracks the total asset deposited and allows sweeping excess
     */
    function _depositIntoVault(
        uint256 _amount
    ) internal virtual returns (uint256) {
        return vault.deposit(_amount, address(this));
    }

    /**
     * @dev Update the exchange rate on the synthetic token by accounting for additional yield accrued to the underlying vault
     * @param _destinationDomain domain of the vault
     */
    function rebase(uint32 _destinationDomain) public payable {
        // force a rebase with an empty transfer to 0x1
        transferRemote(_destinationDomain, NULL_RECIPIENT, 0);
    }
}
