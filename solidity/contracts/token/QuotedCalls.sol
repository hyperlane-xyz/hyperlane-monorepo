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

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "../libs/ReentrancyGuardTransient.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {SignedQuote, IOffchainQuoter} from "../interfaces/IOffchainQuoter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {Quotes} from "./libs/Quotes.sol";

interface ICrossCollateralRouter {
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32);

    function transferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external payable returns (bytes32);

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view returns (Quote[] memory);

    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view returns (Quote[] memory);
}

interface IInterchainAccountRouter {
    function callRemoteWithOverrides(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        CallLib.Call[] memory _calls,
        bytes memory _hookMetadata,
        bytes32 _userSalt
    ) external payable returns (bytes32);

    function callRemoteCommitReveal(
        uint32 _destination,
        bytes32 _router,
        bytes32 _ism,
        bytes memory _hookMetadata,
        IPostDispatchHook _hook,
        bytes32 _salt,
        bytes32 _commitment
    ) external payable returns (bytes32, bytes32);

    function quoteGasPayment(
        address _feeToken,
        uint32 _destination,
        uint256 _gasLimit
    ) external view returns (uint256);

    function quoteGasForCommitReveal(
        address _feeToken,
        uint32 _destination,
        uint256 _gasLimit
    ) external view returns (uint256);
}

/**
 * @title CalldataHeadLib
 * @notice Reads static fields from the ABI-encoded head of calldata and
 *         resolves token amounts / approvals. Shared by QuotedCalls and
 *         factored into a library so callers get a separate stack frame
 *         under --ir-minimum coverage instrumentation.
 */
library CalldataHeadLib {
    using SafeERC20 for IERC20;

    /// @dev Sentinel: resolve to the contract's entire token/ETH balance.
    uint256 internal constant CONTRACT_BALANCE =
        0x8000000000000000000000000000000000000000000000000000000000000000;

    /// @dev Sentinel: infer bridge exact-in amount from the resolved approval budget.
    uint256 internal constant BRIDGE_EXACT_IN =
        0x8000000000000000000000000000000000000000000000000000000000000001;

    function readAddress(
        bytes calldata input,
        uint256 slot
    ) internal pure returns (address) {
        return address(uint160(readUint256(input, slot)));
    }

    function readUint256(
        bytes calldata input,
        uint256 slot
    ) internal pure returns (uint256) {
        uint256 value;
        assembly {
            value := calldataload(add(input.offset, mul(slot, 0x20)))
        }
        return value;
    }

    function readUint32(
        bytes calldata input,
        uint256 slot
    ) internal pure returns (uint32) {
        return uint32(readUint256(input, slot));
    }

    function readBytes32(
        bytes calldata input,
        uint256 slot
    ) internal pure returns (bytes32 value) {
        assembly {
            value := calldataload(add(input.offset, mul(slot, 0x20)))
        }
    }

    function readBytes32At(
        bytes calldata input,
        uint256 byteOffset
    ) internal pure returns (bytes32 value) {
        assembly {
            value := calldataload(add(input.offset, byteOffset))
        }
    }

    function readBytes(
        bytes calldata input,
        uint256 slot
    ) internal pure returns (bytes memory out) {
        uint256 offset = readUint256(input, slot);
        assert(offset + 0x20 <= input.length);

        uint256 start;
        assembly {
            start := add(input.offset, offset)
        }
        uint256 length;
        assembly {
            length := calldataload(start)
        }
        assert(offset + 0x20 + length <= input.length);

        out = new bytes(length);
        assembly {
            calldatacopy(add(out, 0x20), add(start, 0x20), length)
        }
    }

    function resolveAmount(
        address token,
        uint256 amount
    ) internal view returns (uint256) {
        if (amount != CONTRACT_BALANCE) return amount;
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }

    function approve(address token, address spender, uint256 amount) internal {
        if (token != address(0)) IERC20(token).forceApprove(spender, amount);
    }

    /**
     * @dev Read spender (slot 0), token (slot N-2), and approval (slot N-1)
     *      from the ABI-encoded head, resolve the approval, and set allowance.
     * @param input   Full ABI-encoded command input.
     * @param nSlots  Total number of head slots in this command layout.
     */
    function approveFromHead(bytes calldata input, uint256 nSlots) internal {
        address token = readAddress(input, nSlots - 2);
        approve(
            token,
            readAddress(input, 0),
            resolveAmount(token, readUint256(input, nSlots - 1))
        );
    }
}

/**
 * @title QuotedCalls
 * @notice Command-based router for chaining offchain-quoted Hyperlane operations.
 * @dev Follows the UniversalRouter command pattern: execute(bytes commands, bytes[] inputs).
 *      Each command byte maps to a specific Hyperlane operation rather than allowing
 *      arbitrary external calls. Arbitrary calls are not supported because users
 *      may hold standing token approvals to this contract. An arbitrary call
 *      could invoke token.transferFrom(victim, attacker, amount) — draining any
 *      user who has approved this contract. The whitelisted command set ensures
 *      the contract never executes caller-controlled calldata against token
 *      contracts.
 *
 *      Token safety:
 *      - Token inflows use TRANSFER_FROM (standard ERC-20 transferFrom)
 *        or PERMIT2_TRANSFER_FROM (Permit2). Standing ERC-20 approvals
 *        are safe because no arbitrary call command exists — only
 *        whitelisted Hyperlane operations.
 *      - Approvals FROM this contract are set inside TRANSFER_REMOTE /
 *        TRANSFER_REMOTE_TO / CALL_REMOTE_* before the external call. No
 *        standalone APPROVE command exists. These outbound approvals persist
 *        for gas efficiency (avoids zero→non-zero SSTORE on repeat routes).
 *        This is safe because: only whitelisted Hyperlane operations are
 *        callable (no arbitrary external calls), the contract holds no tokens
 *        between transactions, and all targets are user-specified.
 *      - SWEEP: remaining tokens + ETH returned to msg.sender after execution.
 *
 *      Quote salt = keccak256(msg.sender, clientSalt) — binds the quote
 *      to the caller. Quote submitter = address(this) — only this contract
 *      can submit. The signer authorizes a specific user's quotes.
 */
contract QuotedCalls is PackageVersioned, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Quotes for Quote[];

    // ============ Immutables ============

    IAllowanceTransfer public immutable PERMIT2;

    bytes4 private constant PERMIT2_PERMIT_SELECTOR =
        bytes4(
            keccak256(
                "permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)"
            )
        );
    bytes4 private constant SUBMIT_QUOTE_SELECTOR =
        IOffchainQuoter.submitQuote.selector;
    bytes4 private constant CALL_REMOTE_WITH_OVERRIDES_SELECTOR =
        IInterchainAccountRouter.callRemoteWithOverrides.selector;
    bytes4 private constant CALL_REMOTE_COMMIT_REVEAL_SELECTOR =
        IInterchainAccountRouter.callRemoteCommitReveal.selector;

    // ============ Constants ============

    /// @notice Sentinel: resolve amount to this contract's entire token balance
    uint256 public constant CONTRACT_BALANCE = CalldataHeadLib.CONTRACT_BALANCE;

    /// @notice Sentinel: infer bridge exact-in amount from resolved approval budget
    uint256 public constant BRIDGE_EXACT_IN = CalldataHeadLib.BRIDGE_EXACT_IN;

    // ============ Command Types ============
    //
    // Amount/value fields support CONTRACT_BALANCE sentinel to resolve at
    // execution time. For ERC20 amounts this resolves to the contract's token
    // balance; for native value it resolves to address(this).balance.
    //
    // TRANSFER_REMOTE / TRANSFER_REMOTE_TO amount additionally support
    // BRIDGE_EXACT_IN, which infers the largest transfer amount
    // spendable from the resolved approval budget under a linear-fee assumption.
    // Using approval = CONTRACT_BALANCE preserves the "max available exact-in"
    // behavior from current contract balance.
    //
    // SAFETY INVARIANT: users may hold standing ERC-20 approvals to
    // this contract (used by TRANSFER_FROM / PERMIT2_TRANSFER_FROM).
    // These cannot be drained because:
    // (1) Only whitelisted Hyperlane operations are callable — no
    //     arbitrary external call that could invoke
    //     token.transferFrom(victim, attacker, amount).
    // (2) Tokens only enter this contract via TRANSFER_FROM or
    //     PERMIT2_TRANSFER_FROM, both of which pull exclusively from
    //     msg.sender. Whitelisted ops (e.g. transferRemote) then
    //     spend from this contract's balance, but a reentering caller
    //     cannot pull tokens from another user's approval.

    /// @notice Submit an offchain-signed quote to a quoter contract.
    /// @dev quote.salt must equal keccak256(msg.sender, clientSalt) — the
    ///      signer commits to the scoped salt in the EIP-712 signature,
    ///      binding the quote to a specific caller.
    /// inputs: abi.encode(address quoter, SignedQuote quote, bytes signature, bytes32 clientSalt)
    uint256 public constant SUBMIT_QUOTE = 0x00;

    /// @notice Set Permit2 allowance for this contract via owner signature.
    /// inputs: abi.encode(IAllowanceTransfer.PermitSingle permitSingle, bytes signature)
    uint256 public constant PERMIT2_PERMIT = 0x01;

    /// @notice Pull ERC20 tokens from msg.sender via Permit2.
    /// inputs: abi.encode(address token, uint160 amount)
    uint256 public constant PERMIT2_TRANSFER_FROM = 0x02;

    /// @notice Pull ERC20 tokens from msg.sender via standard transferFrom.
    /// inputs: abi.encode(address token, uint256 amount)
    uint256 public constant TRANSFER_FROM = 0x03;

    /// @notice Execute a warp route transferRemote, approving the route first.
    /// @dev amount supports CONTRACT_BALANCE and BRIDGE_EXACT_IN.
    ///      For the exact-in sentinel, approval is the gross spend budget.
    ///      approval resolves via _resolveAmount (supports CONTRACT_BALANCE).
    ///      value resolves native ETH to forward (supports CONTRACT_BALANCE).
    /// inputs: abi.encode(address warpRoute, uint32 destination, bytes32 recipient, uint256 amount, uint256 value, address token, uint256 approval)
    uint256 public constant TRANSFER_REMOTE = 0x04;

    /// @notice Execute a cross-collateral transferRemoteTo, approving the router first.
    /// @dev amount supports CONTRACT_BALANCE and BRIDGE_EXACT_IN.
    ///      For the exact-in sentinel, approval is the gross spend budget.
    ///      Other fields mirror TRANSFER_REMOTE resolution semantics.
    /// inputs: abi.encode(address router, uint32 destination, bytes32 recipient, uint256 amount, bytes32 targetRouter, uint256 value, address token, uint256 approval)
    uint256 public constant TRANSFER_REMOTE_TO = 0x05;

    /// @notice Execute ICA callRemoteWithOverrides, approving the router first.
    /// @dev userSalt is scoped to msg.sender via keccak256(msg.sender, userSalt)
    ///      before being passed to the ICA router.
    /// inputs: abi.encode(address icaRouter, uint32 destination, bytes32 router, bytes32 ism, CallLib.Call[] calls, bytes hookMetadata, bytes32 userSalt, uint256 value, address token, uint256 approval)
    uint256 public constant CALL_REMOTE_WITH_OVERRIDES = 0x06;

    /// @notice Execute ICA callRemoteCommitReveal, approving the router first.
    /// @dev salt is scoped to msg.sender via keccak256(msg.sender, salt)
    ///      before being passed to the ICA router.
    /// inputs: abi.encode(address icaRouter, uint32 destination, bytes32 router, bytes32 ism, bytes hookMetadata, address hook, bytes32 salt, bytes32 commitment, uint256 value, address token, uint256 approval)
    uint256 public constant CALL_REMOTE_COMMIT_REVEAL = 0x07;

    /// @notice Sweep remaining ERC20 and ETH balances back to msg.sender.
    /// @dev Typically the last command to return unused tokens/ETH after fees.
    ///      Pass token = address(0) to sweep only ETH.
    /// inputs: abi.encode(address token)
    uint256 public constant SWEEP = 0x08;

    // ============ Errors ============

    struct TransferRemoteParams {
        address warpRoute;
        uint32 destination;
        bytes32 recipient;
        uint256 amount;
        uint256 value;
        address token;
        uint256 approval;
    }

    struct TransferRemoteToParams {
        address router;
        uint32 destination;
        bytes32 recipient;
        uint256 amount;
        bytes32 targetRouter;
        uint256 value;
        address token;
        uint256 approval;
    }

    error InvalidCommandType(uint256 commandType);
    error InvalidSalt();

    // ============ Constructor ============

    constructor(IAllowanceTransfer _permit2) {
        PERMIT2 = _permit2;
    }

    // ============ External ============

    /**
     * @notice Execute a sequence of commands with encoded inputs.
     * @param commands Concatenated command bytes (1 byte per command)
     * @param inputs ABI-encoded inputs for each command
     */
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external payable nonReentrant {
        require(commands.length == inputs.length, "length mismatch");

        for (uint256 i; i < commands.length; ++i) {
            _dispatch(uint8(commands[i]), inputs[i]);
        }
    }

    /**
     * @notice Quote a sequence of commands without executing transfers.
     * @dev Intended for eth_call only. Runs SUBMIT_QUOTE normally (sets
     *      transient quotes), skips token pull/sweep commands, and returns
     *      per-command Quote[] arrays for transfer/ICA commands.
     *      Same command bytes and inputs as execute().
     * @param commands Concatenated command bytes (1 byte per command)
     * @param inputs ABI-encoded inputs for each command
     * @return results Per-command Quote arrays. Empty for non-quoting commands.
     */
    function quoteExecute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external returns (Quote[][] memory results) {
        require(commands.length == inputs.length, "length mismatch");

        results = new Quote[][](commands.length);
        for (uint256 i; i < commands.length; ++i) {
            results[i] = _dispatchQuote(uint8(commands[i]), inputs[i]);
        }
    }

    // ============ Internal: shared ============

    function _scopeSalt(
        address caller,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(caller, salt));
    }

    function _resolveAmount(
        address token,
        uint256 amount
    ) internal view returns (uint256) {
        return CalldataHeadLib.resolveAmount(token, amount);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        CalldataHeadLib.approve(token, spender, amount);
    }

    function _submitQuote(bytes calldata input) internal {
        address quoter = CalldataHeadLib.readAddress(input, 0);
        uint256 quoteOffset = CalldataHeadLib.readUint256(input, 1);
        uint256 signatureOffset = CalldataHeadLib.readUint256(input, 2);
        bytes32 clientSalt = CalldataHeadLib.readBytes32(input, 3);

        if (
            CalldataHeadLib.readBytes32At(input, quoteOffset + 4 * 32) !=
            _scopeSalt(msg.sender, clientSalt)
        ) revert InvalidSalt();

        _submitQuoteRaw(quoter, input, quoteOffset, signatureOffset);
    }

    // ============ Internal: execute dispatch ============

    function _dispatch(uint256 command, bytes calldata input) internal {
        if (command == SUBMIT_QUOTE) {
            _submitQuote(input);
        } else if (command == PERMIT2_PERMIT) {
            // Use try/catch to handle front-running: if an attacker submits
            // the same permit signature first, the permit is already consumed
            // and this call reverts. Gracefully continue since the allowance
            // was already set by the front-runner's submission.
            _permit2PermitRaw(input);
        } else if (command == PERMIT2_TRANSFER_FROM) {
            address token = CalldataHeadLib.readAddress(input, 0);
            uint160 amount = uint160(CalldataHeadLib.readUint256(input, 1));
            PERMIT2.transferFrom(msg.sender, address(this), amount, token);
        } else if (command == TRANSFER_FROM) {
            address token = CalldataHeadLib.readAddress(input, 0);
            uint256 amount = CalldataHeadLib.readUint256(input, 1);
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        } else if (command == TRANSFER_REMOTE) {
            _dispatchTransferRemote(input);
        } else if (command == TRANSFER_REMOTE_TO) {
            _dispatchTransferRemoteTo(input);
        } else if (command == CALL_REMOTE_WITH_OVERRIDES) {
            _dispatchCallRemoteWithOverrides(input);
        } else if (command == CALL_REMOTE_COMMIT_REVEAL) {
            _dispatchCallRemoteCommitReveal(input);
        } else if (command == SWEEP) {
            address token = CalldataHeadLib.readAddress(input, 0);
            if (token != address(0)) {
                uint256 tokenBalance = IERC20(token).balanceOf(address(this));
                if (tokenBalance > 0) {
                    IERC20(token).safeTransfer(msg.sender, tokenBalance);
                }
            }
            uint256 ethBalance = address(this).balance;
            if (ethBalance > 0) {
                Address.sendValue(payable(msg.sender), ethBalance);
            }
        } else {
            revert InvalidCommandType(command);
        }
    }

    function _dispatchTransferRemote(bytes calldata input) internal {
        TransferRemoteParams memory p = _prepareTransferRemoteParams(input);
        p.value = _resolveAmount(address(0), p.value);
        _approve(p.token, p.warpRoute, _resolveAmount(p.token, p.approval));
        ITokenBridge(p.warpRoute).transferRemote{value: p.value}(
            p.destination,
            p.recipient,
            p.amount
        );
    }

    function _dispatchTransferRemoteTo(bytes calldata input) internal {
        TransferRemoteToParams memory p = _prepareTransferRemoteToParams(input);
        p.value = _resolveAmount(address(0), p.value);
        _approve(p.token, p.router, _resolveAmount(p.token, p.approval));
        ICrossCollateralRouter(p.router).transferRemoteTo{value: p.value}(
            p.destination,
            p.recipient,
            p.amount,
            p.targetRouter
        );
    }

    function _dispatchCallRemoteWithOverrides(bytes calldata input) internal {
        CalldataHeadLib.approveFromHead(input, 10);
        _callRouterWithPatchedInput(
            CalldataHeadLib.readAddress(input, 0),
            CALL_REMOTE_WITH_OVERRIDES_SELECTOR,
            input,
            _resolveAmount(address(0), CalldataHeadLib.readUint256(input, 7)),
            3,
            CalldataHeadLib.readUint256(input, 4) - 32,
            4,
            CalldataHeadLib.readUint256(input, 5) - 32,
            5,
            _scopeSalt(msg.sender, CalldataHeadLib.readBytes32(input, 6))
        );
    }

    function _dispatchCallRemoteCommitReveal(bytes calldata input) internal {
        CalldataHeadLib.approveFromHead(input, 11);
        _executeCommitReveal(input);
    }

    /// @dev Keep commit-reveal forwarding in its own stack frame to avoid
    ///      stack pressure around the approval + patched calldata path.
    function _executeCommitReveal(bytes calldata input) internal {
        _callRouterWithPatchedInput(
            CalldataHeadLib.readAddress(input, 0),
            CALL_REMOTE_COMMIT_REVEAL_SELECTOR,
            input,
            _resolveAmount(address(0), CalldataHeadLib.readUint256(input, 8)),
            3,
            CalldataHeadLib.readUint256(input, 4) - 32,
            5,
            _scopeSalt(msg.sender, CalldataHeadLib.readBytes32(input, 6))
        );
    }

    function _callRouterWithPatchedInput(
        address target,
        bytes4 selector,
        bytes calldata input,
        uint256 value,
        uint256 patchedSlotA,
        uint256 patchedValueA,
        uint256 patchedSlotB,
        bytes32 patchedValueB
    ) internal {
        bytes memory data = new bytes(4 + input.length - 32);
        assembly {
            let dataPtr := add(data, 0x20)
            mstore(dataPtr, selector)
            calldatacopy(
                add(dataPtr, 4),
                add(input.offset, 0x20),
                sub(input.length, 0x20)
            )
        }
        _writeWord(data, patchedSlotA, bytes32(patchedValueA));
        _writeWord(data, patchedSlotB, patchedValueB);
        _call(target, data, value);
    }

    function _permit2PermitRaw(bytes calldata input) internal {
        bytes4 selector = PERMIT2_PERMIT_SELECTOR;
        bytes memory data = new bytes(4 + 32 + input.length);
        assembly {
            let dataPtr := add(data, 0x20)
            mstore(dataPtr, selector)
            mstore(add(dataPtr, 4), caller())
            calldatacopy(add(dataPtr, 0x24), input.offset, input.length)
        }
        _writeWord(
            data,
            7,
            bytes32(CalldataHeadLib.readUint256(input, 6) + 32)
        );
        _callIgnoreFailure(address(PERMIT2), data, 0);
    }

    function _submitQuoteRaw(
        address quoter,
        bytes calldata input,
        uint256 quoteOffset,
        uint256 signatureOffset
    ) internal {
        assert(quoteOffset < signatureOffset);
        uint256 quoteLength = signatureOffset - quoteOffset;
        uint256 signatureLength = input.length - signatureOffset;

        bytes4 selector = SUBMIT_QUOTE_SELECTOR;
        bytes memory data = new bytes(4 + 64 + quoteLength + signatureLength);
        assembly {
            let dataPtr := add(data, 0x20)
            mstore(dataPtr, selector)
            mstore(add(dataPtr, 0x04), 0x40)
            mstore(add(dataPtr, 0x24), add(0x40, quoteLength))
            calldatacopy(
                add(dataPtr, 0x44),
                add(input.offset, quoteOffset),
                quoteLength
            )
            calldatacopy(
                add(add(dataPtr, 0x44), quoteLength),
                add(input.offset, signatureOffset),
                signatureLength
            )
        }
        _call(quoter, data, 0);
    }

    function _callRouterWithPatchedInput(
        address target,
        bytes4 selector,
        bytes calldata input,
        uint256 value,
        uint256 patchedSlotA,
        uint256 patchedValueA,
        uint256 patchedSlotB,
        uint256 patchedValueB,
        uint256 patchedSlotC,
        bytes32 patchedValueC
    ) internal {
        bytes memory data = new bytes(4 + input.length - 32);
        assembly {
            let dataPtr := add(data, 0x20)
            mstore(dataPtr, selector)
            calldatacopy(
                add(dataPtr, 4),
                add(input.offset, 0x20),
                sub(input.length, 0x20)
            )
        }
        _writeWord(data, patchedSlotA, bytes32(patchedValueA));
        _writeWord(data, patchedSlotB, bytes32(patchedValueB));
        _writeWord(data, patchedSlotC, patchedValueC);
        _call(target, data, value);
    }

    function _writeWord(
        bytes memory data,
        uint256 slot,
        bytes32 value
    ) private pure {
        assembly {
            mstore(add(add(data, 0x24), mul(slot, 0x20)), value)
        }
    }

    function _call(address target, bytes memory data, uint256 value) private {
        (bool success, bytes memory returndata) = target.call{value: value}(
            data
        );
        if (!success) {
            assembly {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }
    }

    function _callIgnoreFailure(
        address target,
        bytes memory data,
        uint256 value
    ) private {
        target.call{value: value}(data);
    }

    // ============ Internal: quote dispatch ============

    function _dispatchQuote(
        uint256 command,
        bytes calldata input
    ) internal returns (Quote[] memory) {
        if (command == SUBMIT_QUOTE) {
            _submitQuote(input);
            return new Quote[](0);
        } else if (command == TRANSFER_REMOTE) {
            return _quoteTransferRemote(input);
        } else if (command == TRANSFER_REMOTE_TO) {
            return _quoteTransferRemoteTo(input);
        } else if (command == CALL_REMOTE_WITH_OVERRIDES) {
            return _quoteCallRemoteWithOverrides(input);
        } else if (command == CALL_REMOTE_COMMIT_REVEAL) {
            return _quoteCallRemoteCommitReveal(input);
        }
        // PERMIT2_PERMIT, PERMIT2_TRANSFER_FROM, TRANSFER_FROM, SWEEP: skip
        if (
            command != PERMIT2_PERMIT &&
            command != PERMIT2_TRANSFER_FROM &&
            command != TRANSFER_FROM &&
            command != SWEEP
        ) revert InvalidCommandType(command);
        return new Quote[](0);
    }

    function _quoteTransferRemote(
        bytes calldata input
    ) private view returns (Quote[] memory) {
        TransferRemoteParams memory p = _prepareTransferRemoteParams(input);
        return
            ITokenBridge(p.warpRoute).quoteTransferRemote(
                p.destination,
                p.recipient,
                p.amount
            );
    }

    function _quoteTransferRemoteTo(
        bytes calldata input
    ) private view returns (Quote[] memory) {
        TransferRemoteToParams memory p = _prepareTransferRemoteToParams(input);
        return
            ICrossCollateralRouter(p.router).quoteTransferRemoteTo(
                p.destination,
                p.recipient,
                p.amount,
                p.targetRouter
            );
    }

    function _prepareTransferRemoteParams(
        bytes calldata input
    ) private view returns (TransferRemoteParams memory p) {
        p.warpRoute = CalldataHeadLib.readAddress(input, 0);
        p.destination = CalldataHeadLib.readUint32(input, 1);
        p.recipient = CalldataHeadLib.readBytes32(input, 2);
        p.amount = CalldataHeadLib.readUint256(input, 3);
        p.value = CalldataHeadLib.readUint256(input, 4);
        p.token = CalldataHeadLib.readAddress(input, 5);
        p.approval = CalldataHeadLib.readUint256(input, 6);
        if (p.amount != BRIDGE_EXACT_IN) {
            p.amount = _resolveAmount(p.token, p.amount);
            return p;
        }

        uint256 available = _resolveAmount(p.token, p.approval);
        p.amount = _resolveBridgeAmount(
            available,
            ITokenBridge(p.warpRoute)
                .quoteTransferRemote(p.destination, p.recipient, available)
                .extract(p.token)
        );
    }

    function _prepareTransferRemoteToParams(
        bytes calldata input
    ) private view returns (TransferRemoteToParams memory p) {
        p.router = CalldataHeadLib.readAddress(input, 0);
        p.destination = CalldataHeadLib.readUint32(input, 1);
        p.recipient = CalldataHeadLib.readBytes32(input, 2);
        p.amount = CalldataHeadLib.readUint256(input, 3);
        p.targetRouter = CalldataHeadLib.readBytes32(input, 4);
        p.value = CalldataHeadLib.readUint256(input, 5);
        p.token = CalldataHeadLib.readAddress(input, 6);
        p.approval = CalldataHeadLib.readUint256(input, 7);
        if (p.amount != BRIDGE_EXACT_IN) {
            p.amount = _resolveAmount(p.token, p.amount);
            return p;
        }

        uint256 available = _resolveAmount(p.token, p.approval);
        p.amount = _resolveBridgeAmount(
            available,
            ICrossCollateralRouter(p.router)
                .quoteTransferRemoteTo(
                    p.destination,
                    p.recipient,
                    available,
                    p.targetRouter
                )
                .extract(p.token)
        );
    }

    function _resolveBridgeAmount(
        uint256 available,
        uint256 quotedTotal
    ) private pure returns (uint256) {
        if (available == 0) return 0;
        return _invertBridgeExactIn(available, quotedTotal);
    }

    function _invertBridgeExactIn(
        uint256 available,
        uint256 totalQuoted
    ) private pure returns (uint256) {
        if (totalQuoted <= available) return available;
        return Math.mulDiv(available, available, totalQuoted);
    }

    function _quoteIcaGasPayment(
        address icaRouter,
        uint32 destination,
        bytes memory hookMetadata,
        address token
    ) internal view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: token,
            amount: IInterchainAccountRouter(icaRouter).quoteGasPayment(
                token,
                destination,
                StandardHookMetadata.gasLimit(hookMetadata)
            )
        });
    }

    function _quoteCallRemoteWithOverrides(
        bytes calldata input
    ) internal view returns (Quote[] memory) {
        address icaRouter = CalldataHeadLib.readAddress(input, 0);
        uint32 destination = CalldataHeadLib.readUint32(input, 1);
        bytes memory hookMetadata = CalldataHeadLib.readBytes(input, 5);
        address token = CalldataHeadLib.readAddress(input, 8);
        return _quoteIcaGasPayment(icaRouter, destination, hookMetadata, token);
    }

    function _quoteCallRemoteCommitReveal(
        bytes calldata input
    ) internal view returns (Quote[] memory quotes) {
        address icaRouter = CalldataHeadLib.readAddress(input, 0);
        uint32 destination = CalldataHeadLib.readUint32(input, 1);
        bytes memory hookMetadata = CalldataHeadLib.readBytes(input, 4);
        address token = CalldataHeadLib.readAddress(input, 9);
        // Commit-reveal pays for two dispatches (commit + reveal).
        // quoteGasForCommitReveal returns the combined cost.
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: token,
            amount: IInterchainAccountRouter(icaRouter).quoteGasForCommitReveal(
                token,
                destination,
                StandardHookMetadata.gasLimit(hookMetadata)
            )
        });
    }

    receive() external payable {}
}
