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
import {IAxelarGateway} from "../interfaces/axelar/IAxelarGateway.sol";
import {IAxelarGasService} from "../interfaces/axelar/IAxelarGasService.sol";
import {AddressToString} from "../interfaces/axelar/AddressString.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title AxelarHook
 * @notice Message hook that informs an {AxelarIsm} of message IDs dispatched
 * through the Hyperlane Mailbox, transporting them via Axelar's General Message
 * Passing (GMP).
 * @dev On `postDispatch` the hook pre-pays the Axelar Gas Service in native
 * tokens and calls `IAxelarGateway.callContract`, carrying a payload that
 * invokes `AbstractMessageIdAuthorizedIsm.preVerifyMessage` on the destination ISM.
 *
 * Gas model (the maintainer's suggested shortcut in #2851):
 *  - The exact Axelar GMP gas cost cannot be computed on-chain (it depends on
 *    destination gas price and token exchange rates resolved by Axelar's
 *    off-chain gas oracle), so `quoteDispatch` returns 0 and the caller instead
 *    attaches native value when dispatching.
 *  - The hook forwards the entire attached value to
 *    `payNativeGasForContractCall` — i.e. it over-pays — and Axelar refunds any
 *    surplus off-chain to the metadata refund address. Callers should attach a
 *    generous amount; under-payment simply stalls relaying until more gas is
 *    added via the Axelar Gas Service.
 *
 * Native value bridging (`metadata.msgValue`) is NOT supported: Axelar GMP does
 * not deliver native value to the destination contract, so any non-zero
 * `msgValue` is rejected to avoid silently stranding funds.
 *
 * Like {OPStackHook}, a hook instance is bound to a single destination domain.
 */
contract AxelarHook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using AddressToString for address;

    // ============ Constants ============

    /// @notice Axelar Gateway on the origin chain.
    IAxelarGateway public immutable axelarGateway;
    /// @notice Axelar Gas Service on the origin chain.
    IAxelarGasService public immutable axelarGasService;

    // ============ Storage ============

    /// @notice Axelar chain name of the destination chain (e.g. "arbitrum").
    /// @dev A string (not immutable) because Solidity immutables cannot be strings.
    string public destinationChain;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _axelarGateway,
        address _axelarGasService,
        string memory _destinationChain
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(
            Address.isContract(_axelarGateway),
            "AxelarHook: invalid gateway"
        );
        require(
            Address.isContract(_axelarGasService),
            "AxelarHook: invalid gas service"
        );
        require(
            bytes(_destinationChain).length != 0,
            "AxelarHook: invalid destination chain"
        );
        axelarGateway = IAxelarGateway(_axelarGateway);
        axelarGasService = IAxelarGasService(_axelarGasService);
        destinationChain = _destinationChain;
    }

    // ============ Internal functions ============

    /// @dev Returns 0: Axelar gas cannot be quoted on-chain. The caller attaches
    /// native value, which the hook over-pays to the Axelar Gas Service.
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) internal pure override returns (uint256) {
        require(
            metadata.msgValue(0) == 0,
            "AxelarHook: msgValue not supported"
        );
        return 0;
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        require(
            metadata.msgValue(0) == 0,
            "AxelarHook: msgValue not supported"
        );

        // Destination ISM address, encoded as the 0x-prefixed hex string Axelar expects.
        string memory ismAddress = TypeCasts
            .bytes32ToAddress(ism)
            .toString();

        // Payload invokes preVerifyMessage(messageId, 0) on the destination ISM.
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (message.id(), 0)
        );

        // Over-pay the Axelar Gas Service with all attached value; surplus is
        // refunded off-chain to the refund address by Axelar.
        axelarGasService.payNativeGasForContractCall{
            value: address(this).balance
        }(
            address(this),
            destinationChain,
            ismAddress,
            payload,
            metadata.refundAddress(message.senderAddress())
        );

        // Emit the GMP call; Axelar validators relay it to the destination ISM.
        axelarGateway.callContract(destinationChain, ismAddress, payload);
    }
}
