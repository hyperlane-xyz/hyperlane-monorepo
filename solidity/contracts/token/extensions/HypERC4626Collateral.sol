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

// ============ External Imports ============
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

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
        wrappedToken.approve(address(vault), type(uint256).max);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 dispatchValue) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);
        HypERC20Collateral._transferFromSender(_amount + fee);
        if (fee > 0) {
            HypERC20Collateral._transferTo(feeRecipient(), fee);
        }
        return msg.value;
    }

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        internal
        virtual
        override
        returns (uint256 dispatchValue, bytes memory message)
    {
        dispatchValue = _chargeSender(_destination, _recipient, _amount);

        uint256 _shares = _depositIntoVault(_amount);

        uint256 _exchangeRate = vault.convertToAssets(PRECISION);

        rateUpdateNonce++;
        bytes memory _tokenMetadata = abi.encode(
            _exchangeRate,
            rateUpdateNonce
        );

        uint256 _outboundAmount = _outboundAmount(_shares);
        message = TokenMessage.format(
            _recipient,
            _outboundAmount,
            _tokenMetadata
        );
    }

    /**
     * @dev Deposits into the vault and increment assetDeposited
     * @param _amount amount to deposit into vault
     */
    function _depositIntoVault(
        uint256 _amount
    ) internal virtual returns (uint256) {
        return vault.deposit(_amount, address(this));
    }

    /**
     * @dev Withdraws `_shares` of `wrappedToken` from this contract to `_recipient`
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _shares
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
            _hookMetadata,
            _hook
        );
    }
}
