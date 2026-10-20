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
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {IGasOracle} from "../interfaces/IGasOracle.sol";

// ============ External Imports ============
import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbitrumOrbitHook
 * @notice Message hook to inform the ArbitrumOrbitIsm of messages published through
 * Arbitrum's native Inbox createRetryableTicket mechanism.
 * @notice This works for L1 -> L2 messages (e.g. Ethereum -> Arbitrum One, or L2 -> Orbit L3).
 */
contract ArbitrumOrbitHook is AbstractMessageIdAuthHook {
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    /// @notice Arbitrum Inbox contract on L1
    IInbox public immutable l1Inbox;
    /// @notice Optional Hyperlane gas oracle for queryable L2 gas prices
    IGasOracle public immutable gasOracle;

    /// @notice Default gas limit for retryable ticket execution on L2 if not provided in metadata
    uint256 public constant DEFAULT_GAS_LIMIT = 300_000;
    /// @notice Default max fee per gas if neither metadata nor gas oracle provides one (0.1 gwei)
    uint256 public constant DEFAULT_MAX_FEE_PER_GAS = 100_000_000;
    /// @notice Payload length for preVerifyMessage(bytes32,uint256): 4 + 32 + 32 = 68 bytes
    uint256 private constant DATA_LENGTH = 68;
    /// @dev See StandardHookMetadata.sol: [0:2] variant, [2:34] msgValue, [34:66] gasLimit, [66:86] refundAddress
    uint256 private constant CUSTOM_METADATA_OFFSET = 86;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _l1Inbox,
        address _gasOracle
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(Address.isContract(_l1Inbox), "ArbitrumOrbitHook: invalid inbox");
        l1Inbox = IInbox(_l1Inbox);
        gasOracle = IGasOracle(_gasOracle);
    }

    // ============ Internal functions ============

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) internal view override returns (uint256) {
        return
            metadata.msgValue(0) +
            (_gasLimit(metadata) * _maxFeePerGas(metadata)) +
            _submissionFee();
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (message.id(), metadata.msgValue(0))
        );

        address refundAddress = metadata.refundAddress(msg.sender);
        uint256 gasLimit = _gasLimit(metadata);
        uint256 maxFeePerGas = _maxFeePerGas(metadata);
        uint256 maxSubmissionCost = _submissionFee();
        uint256 totalCost = maxSubmissionCost + (gasLimit * maxFeePerGas) + metadata.msgValue(0);

        require(
            address(this).balance >= totalCost,
            "ArbitrumOrbitHook: insufficient balance"
        );

        l1Inbox.createRetryableTicket{value: totalCost}(
            TypeCasts.bytes32ToAddress(ism),
            metadata.msgValue(0),
            maxSubmissionCost,
            refundAddress,
            refundAddress,
            gasLimit,
            maxFeePerGas,
            payload
        );
    }

    function _gasLimit(
        bytes calldata metadata
    ) internal pure returns (uint256) {
        return metadata.gasLimit(DEFAULT_GAS_LIMIT);
    }

    function _submissionFee() internal view returns (uint256) {
        return l1Inbox.calculateRetryableSubmissionFee(DATA_LENGTH, 0);
    }

    function _maxFeePerGas(
        bytes calldata metadata
    ) internal view returns (uint256) {
        if (metadata.length >= CUSTOM_METADATA_OFFSET + 32) {
            return uint256(bytes32(metadata[CUSTOM_METADATA_OFFSET:CUSTOM_METADATA_OFFSET + 32]));
        }
        if (Address.isContract(address(gasOracle))) {
            try gasOracle.getExchangeRateAndGasPrice(destinationDomain) returns (
                uint128,
                uint128 maxGasPriceU128
            ) {
                if (maxGasPriceU128 > 0) {
                    return uint256(maxGasPriceU128);
                }
            } catch {}
        }
        return DEFAULT_MAX_FEE_PER_GAS;
    }
}
