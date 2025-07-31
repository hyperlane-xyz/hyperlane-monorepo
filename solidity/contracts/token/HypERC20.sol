// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {GasRouter} from "../client/GasRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {DecimalScaleable} from "./libs/mixins/DecimalScaleable.sol";
import {FeeChargeable} from "./libs/mixins/FeeChargeable.sol";

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title Hyperlane ERC20 Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypERC20 is GasRouter, ERC20Upgradeable, ITokenBridge {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint8 private immutable _decimals;
    uint256 public immutable scale;

    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox
    ) GasRouter(_mailbox) {
        _decimals = __decimals;
        scale = _scale;
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
    ) public virtual initializer {
        // Initialize ERC20 metadata
        __ERC20_init(_name, _symbol);
        _mint(msg.sender, _totalSupply);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function token() public view virtual override returns (address) {
        return address(this);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[3] memory quotes) {
        quotes[0] = Quote({
            token: address(0),
            amount: _GasRouter_quoteDispatch(
                _destination,
                TokenMessage.format(_recipient, _amount)
            )
        });
        quotes[1] = Quote({token: address(this), amount: _amount});
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(this),
            _destination,
            _recipient,
            _amount
        );
        quotes[2] = Quote({token: address(this), amount: fee});
        return quotes;
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual returns (bytes32 messageId) {
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(this),
            _destination,
            _recipient,
            _amount
        );
        _burn(msg.sender, _amount + fee);
        if (fee > 0) {
            _mint(FeeChargeable.getFeeRecipient(), fee);
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

        _mint(recipient.bytes32ToAddress(), scaledAmount);
    }
}
