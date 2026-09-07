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
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AxelarExecutable} from "../../interfaces/axelar/AxelarExecutable.sol";
import {StringToAddress} from "../../interfaces/axelar/AddressString.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title AxelarIsm
 * @notice Uses Axelar's General Message Passing to verify interchain messages.
 * @dev Inherits {AxelarExecutable}: the Axelar Gateway-validated `execute`
 * entrypoint dispatches to `_execute`, where the source is authorized and the
 * Hyperlane message ID is recorded via `preVerifyMessage`.
 *
 * Trust model:
 *  - {AxelarExecutable.execute} guarantees, via `gateway.validateContractCall`,
 *    that the Axelar network approved this exact (sourceChain, sourceAddress,
 *    payload) delivery.
 *  - `_execute` then requires the delivery originated on the trusted origin
 *    chain and from the authorized hook, before recording verification.
 *
 * Because authorization is established from Axelar's validated call arguments
 * (not `msg.sender`), `preVerifyMessage` is reached through a self-call guarded
 * by the transient `_verifying` flag, so it can only ever be set during a
 * gateway-validated, source-authorized `execute`. Direct external calls to
 * `preVerifyMessage` revert.
 *
 * Native value bridging is not supported (Axelar GMP carries no native value to
 * the destination); the recorded `msgValue` is always 0.
 */
contract AxelarIsm is AxelarExecutable, AbstractMessageIdAuthorizedIsm {
    using StringToAddress for string;
    using Address for address;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    /// @notice keccak256 of the trusted Axelar source (origin) chain name.
    bytes32 public immutable originChainHash;

    // ============ Storage ============

    /// @notice Human-readable Axelar origin chain name, retained for introspection.
    string public originChain;

    /// @dev True only for the duration of a gateway-validated, source-authorized
    /// `execute`, gating the self-call into `preVerifyMessage`.
    bool private _verifying;

    // ============ Constructor ============

    constructor(
        address _axelarGateway,
        string memory _originChain
    ) AxelarExecutable(_axelarGateway) {
        require(
            bytes(_originChain).length != 0,
            "AxelarIsm: invalid origin chain"
        );
        originChain = _originChain;
        originChainHash = keccak256(bytes(_originChain));
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return _verifying && msg.sender == address(this);
    }

    /// @inheritdoc AxelarExecutable
    function _execute(
        bytes32,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal override {
        require(
            keccak256(bytes(sourceChain)) == originChainHash,
            "AxelarIsm: untrusted source chain"
        );
        require(
            sourceAddress.toAddress() ==
                TypeCasts.bytes32ToAddress(authorizedHook),
            "AxelarIsm: untrusted source address"
        );
        // Defense in depth: only the message-id verification call is ever forwarded.
        require(
            payload.length >= 4 &&
                bytes4(payload[0:4]) ==
                AbstractMessageIdAuthorizedIsm.preVerifyMessage.selector,
            "AxelarIsm: invalid payload"
        );

        _verifying = true;
        // Self-call records verification through preVerifyMessage, whose
        // _isAuthorized() check passes only while `_verifying` is set.
        address(this).functionCall(payload);
        _verifying = false;
    }
}
