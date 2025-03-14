// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "./HypNative.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Native/ERC20 tokens L2 to L1 value transfer abstraction
 * @author Substance Labs
 * @dev Derives from the Hyperlane native token router, but supports
 * transfer of ERC20 token value
 */
abstract contract ValueTransferBridgeNative is HypNative {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 constant HOOK_METADATA_GAS_LIMIT = 700_000;

    // L2 bridge used to initiate the withdrawal
    address public l2Bridge;

    /**
     * @dev see MailboxClient's initializer for other configurables
     */
    constructor(address _l2Bridge, address _mailbox) HypNative(_mailbox) {
        l2Bridge = _l2Bridge;
        _transferOwnership(_msgSender()); // TODO: remove
    }

    function setL2Bridge(address _l2Bridge) external onlyOwner {
        l2Bridge = _l2Bridge;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual returns (uint256 fees) {
        // Check HypNative._transferFromSender()
        bytes memory _tokenMetadata = bytes("");
        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _amount,
            _tokenMetadata
        );

        bytes memory _extraData = bytes("");

        fees =
            _Router_quoteDispatch(
                _destination,
                _tokenMessage,
                _getHookMetadata(),
                address(hook)
            ) +
            _l2BridgeQuoteTransferRemote(
                _destination,
                _recipient,
                _amount,
                _extraData
            );
    }

    function transferRemote(
        uint32 /* _destination */,
        bytes32 /* _recipient */,
        uint256 /* _amount */,
        bytes calldata /* _hookMetadata */,
        address /* _hook */
    ) external payable override returns (bytes32) {
        require(false, "Unavailable");
    }

    /// @inheritdoc TokenRouter
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId
    ) external payable override returns (bytes32) {
        bytes32 _router = _mustHaveRemoteRouter(_destination);
        uint256 _value = msg.value - _amountOrId;
        bytes memory _extraData = bytes("");

        _l2BridgeTransferRemote(_destination, _router, _amountOrId, _extraData);

        return
            _transferRemote(
                _destination,
                _recipient,
                _amountOrId,
                _value,
                _getHookMetadata(),
                address(hook) // (i.e. OPL2ToL1ProveWithdrawalHook)
            );
    }

    /**
     * @notice Implements the value transfer (through a withdrawal) on L2
     * @param _destination destination domain
     * @param _recipient the receiver of the funds
     * @param _amount amount to transfer
     * @param _extraData data to send within the withdrawal operation
     */
    function _l2BridgeTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _extraData
    ) internal virtual;

    /**
     * @notice Returns the rollup bridge fees needed to perform the tranfer to L1
     * @param _destination destination domain
     * @param _recipient the receiver of the funds
     * @param _amount amount to transfer
     */
    function _l2BridgeQuoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _extraData
    ) internal view virtual returns (uint256) {
        return 0;
    }

    function _getHookMetadata() internal view returns (bytes memory) {
        return StandardHookMetadata.overrideGasLimit(HOOK_METADATA_GAS_LIMIT);
    }

    /**
     * @dev Transfer the value to the recipient when the withdrawal is finalized
     * @dev Emits `ReceivedTransferRemote` event on the destination chain.
     * @param _origin The identifier of the origin chain.
     * @param _message The encoded remote transfer message containing the recipient address and amount.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();

        Address.sendValue(payable(recipient.bytes32ToAddress()), amount);

        emit ReceivedTransferRemote(_origin, recipient, amount);
    }
}
