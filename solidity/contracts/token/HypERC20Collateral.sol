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
import {GasRouter} from "../client/GasRouter.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {DecimalScaleable} from "./libs/mixins/DecimalScaleable.sol";
import {FeeChargeable} from "./libs/mixins/FeeChargeable.sol";
import {LPable} from "./libs/mixins/LPable.sol";
import {RebalanceableMixin} from "./libs/mixins/RebalanceableMixin.sol";
import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Hyperlane ERC20 Token Collateral that wraps an existing ERC20 with remote transfer functionality.
 * @author Abacus Works
 */
contract HypERC20Collateral is GasRouter, ITokenBridge {
    using SafeERC20 for IERC20;
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    IERC20 public immutable wrappedToken;
    uint256 public immutable scale;

    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) GasRouter(_mailbox) {
        require(Address.isContract(erc20), "HypERC20Collateral: invalid token");
        wrappedToken = IERC20(erc20);
        scale = _scale;
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public virtual initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        // _LPable_initialize(address(wrappedToken));
    }

    function token() public view virtual override returns (address) {
        return address(wrappedToken);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[3] memory quotes) {
        uint256 scaledAmount = DecimalScaleable.scaleOutbound(_amount, scale);
        bytes memory message = TokenMessage.format(_recipient, scaledAmount);
        quotes[0] = Quote({
            token: address(0),
            amount: _GasRouter_quoteDispatch(_destination, message)
        });
        quotes[1] = Quote({token: address(wrappedToken), amount: _amount});
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(wrappedToken),
            _destination,
            _recipient,
            _amount
        );
        quotes[2] = Quote({token: address(wrappedToken), amount: fee});
        return quotes;
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual returns (bytes32 messageId) {
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(wrappedToken),
            _destination,
            _recipient,
            _amount
        );
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount + fee);
        if (fee > 0) {
            wrappedToken.safeTransfer(FeeChargeable.getFeeRecipient(), fee);
        }

        uint256 scaledAmount = DecimalScaleable.scaleOutbound(_amount, scale);
        emit SentTransferRemote(_destination, _recipient, scaledAmount);

        bytes memory message = TokenMessage.format(_recipient, scaledAmount);

        return _GasRouter_dispatch(_destination, msg.value, message);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();

        emit ReceivedTransferRemote(_origin, recipient, amount);

        uint256 scaledAmount = DecimalScaleable.scaleInbound(amount, scale);
        wrappedToken.safeTransfer(recipient.bytes32ToAddress(), scaledAmount);
    }
}
