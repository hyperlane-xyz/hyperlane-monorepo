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
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {SignedQuote, IOffchainQuoter} from "../interfaces/IOffchainQuoter.sol";
import {ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

/**
 * @title QuotedCalls
 * @notice Command-based router for chaining offchain-quoted Hyperlane operations.
 * @dev Follows the UniversalRouter command pattern: execute(bytes commands, bytes[] inputs).
 *      Each command byte maps to a specific Hyperlane operation rather than allowing
 *      arbitrary external calls. Arbitrary calls are not supported because this
 *      contract holds transient token approvals — an arbitrary call could spend
 *      those approvals on behalf of a different user.
 *
 *      Token safety:
 *      - Token inflows use Permit2 (no standing approvals to this contract) or
 *        PERMIT2_TRANSFER_FROM from msg.sender as fallback.
 *      - Approvals are transient: embedded inside TRANSFER_REMOTE / TRANSFER_REMOTE_TO /
 *        CALL_REMOTE_*, set before the call and revoked after. No standalone APPROVE command
 *        exists, preventing attackers from pre-setting persistent approvals.
 *      - SWEEP: remaining tokens + ETH returned to msg.sender after execution.
 *
 *      Quote salt = keccak256(msg.sender, clientSalt) — binds the quote
 *      to the caller. Quote submitter = address(this) — only this contract
 *      can submit. The signer authorizes a specific user's quotes.
 */
contract QuotedCalls is PackageVersioned, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    IAllowanceTransfer public immutable PERMIT2;

    // ============ Constants ============

    /// @notice Sentinel: resolve amount to this contract's entire token balance
    uint256 public constant CONTRACT_BALANCE =
        0x8000000000000000000000000000000000000000000000000000000000000000;

    // ============ Command Types ============
    //
    // Amount/value fields support CONTRACT_BALANCE sentinel to resolve at
    // execution time. For ERC20 amounts this resolves to the contract's token
    // balance; for native value it resolves to address(this).balance.
    //
    // SAFETY INVARIANT: transient approvals cannot be spent by an attacker.
    // This holds because: (1) only whitelisted Hyperlane operations are
    // callable — no arbitrary external calls that could drain approvals,
    // (2) approvals are set immediately before the call and revoked
    // immediately after, and (3) execute() is protected by reentrancy guard,
    // so the approval window cannot be exploited via reentrant calls.

    /// @notice Submit an offchain-signed quote to a quoter contract.
    /// @dev quote.salt must equal keccak256(msg.sender, clientSalt) — the
    ///      signer commits to the scoped salt in the EIP-712 signature,
    ///      binding the quote to a specific caller.
    /// inputs: abi.encode(address quoter, SignedQuote quote, bytes signature, bytes32 clientSalt)
    uint256 public constant SUBMIT_QUOTE = 0x00;

    /// @notice Set Permit2 allowance for this contract via owner signature.
    /// inputs: abi.encode(IAllowanceTransfer.PermitSingle permitSingle, bytes signature)
    uint256 public constant PERMIT2_PERMIT = 0x01;

    /// @notice Pull ERC20 tokens from msg.sender. Tries transferFrom first,
    ///         falls back to Permit2 transferFrom if the direct transfer fails.
    /// inputs: abi.encode(address token, uint256 amount)
    uint256 public constant PERMIT2_TRANSFER_FROM = 0x02;

    /// @notice Execute a warp route transferRemote with transient approval.
    /// @dev amount and approval resolve via _resolveAmount (supports CONTRACT_BALANCE).
    ///      value resolves native ETH to forward (supports CONTRACT_BALANCE).
    /// inputs: abi.encode(address warpRoute, uint32 destination, bytes32 recipient, uint256 amount, uint256 value, address token, uint256 approval)
    uint256 public constant TRANSFER_REMOTE = 0x03;

    /// @notice Execute a cross-collateral transferRemoteTo with transient approval.
    /// @dev Same resolution semantics as TRANSFER_REMOTE.
    /// inputs: abi.encode(address router, uint32 destination, bytes32 recipient, uint256 amount, bytes32 targetRouter, uint256 value, address token, uint256 approval)
    uint256 public constant TRANSFER_REMOTE_TO = 0x04;

    /// @notice Execute ICA callRemoteWithOverrides with transient approval.
    /// @dev userSalt is scoped to msg.sender via keccak256(msg.sender, userSalt)
    ///      before being passed to the ICA router.
    /// inputs: abi.encode(address icaRouter, uint32 destination, bytes32 router, bytes32 ism, CallLib.Call[] calls, bytes hookMetadata, bytes32 userSalt, uint256 value, address token, uint256 approval)
    uint256 public constant CALL_REMOTE_WITH_OVERRIDES = 0x05;

    /// @notice Execute ICA callRemoteCommitReveal with transient approval.
    /// @dev salt is scoped to msg.sender via keccak256(msg.sender, salt)
    ///      before being passed to the ICA router.
    /// inputs: abi.encode(address icaRouter, uint32 destination, bytes32 router, bytes32 ism, bytes hookMetadata, address hook, bytes32 salt, bytes32 commitment, uint256 value, address token, uint256 approval)
    uint256 public constant CALL_REMOTE_COMMIT_REVEAL = 0x06;

    /// @notice Sweep remaining ERC20 and ETH balances back to msg.sender.
    /// @dev Typically the last command to return unused tokens/ETH after fees.
    ///      Pass token = address(0) to sweep only ETH.
    /// inputs: abi.encode(address token)
    uint256 public constant SWEEP = 0x07;

    // ============ Errors ============

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

    // ============ Internal ============

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
        if (amount != CONTRACT_BALANCE) return amount;
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }

    function _transientApprove(
        address token,
        address spender,
        uint256 amount
    ) internal {
        if (token != address(0)) IERC20(token).forceApprove(spender, amount);
    }

    function _transientRevoke(address token, address spender) internal {
        if (token != address(0)) IERC20(token).forceApprove(spender, 0);
    }

    function _dispatch(uint256 command, bytes calldata input) internal {
        if (command == SUBMIT_QUOTE) {
            (
                address quoter,
                SignedQuote memory quote,
                bytes memory signature,
                bytes32 clientSalt
            ) = abi.decode(input, (address, SignedQuote, bytes, bytes32));
            // signer signs scopedSalt = keccak256(msg.sender, clientSalt).
            // prevents cross-user replay while letting callers choose salts.
            bytes32 scopedSalt = _scopeSalt(msg.sender, clientSalt);
            if (quote.salt != scopedSalt) revert InvalidSalt();
            IOffchainQuoter(quoter).submitQuote(quote, signature);
        } else if (command == PERMIT2_PERMIT) {
            (
                IAllowanceTransfer.PermitSingle memory permitSingle,
                bytes memory signature
            ) = abi.decode(input, (IAllowanceTransfer.PermitSingle, bytes));
            PERMIT2.permit(msg.sender, permitSingle, signature);
        } else if (command == PERMIT2_TRANSFER_FROM) {
            (address token, uint256 amount) = abi.decode(
                input,
                (address, uint256)
            );
            // Low-level call to handle non-standard ERC20s (no return value).
            // Check code.length first — call to EOA returns success with no data,
            // which would skip the Permit2 fallback without transferring tokens.
            bool transferred;
            if (token.code.length > 0) {
                (bool success, bytes memory data) = token.call(
                    abi.encodeWithSelector(
                        IERC20.transferFrom.selector,
                        msg.sender,
                        address(this),
                        amount
                    )
                );
                transferred =
                    success &&
                    (data.length == 0 || abi.decode(data, (bool)));
            }
            if (!transferred) {
                PERMIT2.transferFrom(
                    msg.sender,
                    address(this),
                    uint160(amount),
                    token
                );
            }
        } else if (command == TRANSFER_REMOTE) {
            (
                address warpRoute,
                uint32 destination,
                bytes32 recipient,
                uint256 amount,
                uint256 value,
                address token,
                uint256 approval
            ) = abi.decode(
                    input,
                    (
                        address,
                        uint32,
                        bytes32,
                        uint256,
                        uint256,
                        address,
                        uint256
                    )
                );
            amount = _resolveAmount(token, amount);
            value = _resolveAmount(address(0), value);
            approval = _resolveAmount(token, approval);
            _transientApprove(token, warpRoute, approval);
            ITokenBridge(warpRoute).transferRemote{value: value}(
                destination,
                recipient,
                amount
            );
            _transientRevoke(token, warpRoute);
        } else if (command == TRANSFER_REMOTE_TO) {
            (
                address router,
                uint32 destination,
                bytes32 recipient,
                uint256 amount,
                bytes32 targetRouter,
                uint256 value,
                address token,
                uint256 approval
            ) = abi.decode(
                    input,
                    (
                        address,
                        uint32,
                        bytes32,
                        uint256,
                        bytes32,
                        uint256,
                        address,
                        uint256
                    )
                );
            amount = _resolveAmount(token, amount);
            value = _resolveAmount(address(0), value);
            approval = _resolveAmount(token, approval);
            _transientApprove(token, router, approval);
            (bool success, ) = router.call{value: value}(
                abi.encodeWithSignature(
                    "transferRemoteTo(uint32,bytes32,uint256,bytes32)",
                    destination,
                    recipient,
                    amount,
                    targetRouter
                )
            );
            require(success, "transferRemoteTo failed");
            _transientRevoke(token, router);
        } else if (command == CALL_REMOTE_WITH_OVERRIDES) {
            (
                address icaRouter,
                uint32 destination,
                bytes32 router,
                bytes32 ism,
                CallLib.Call[] memory calls,
                bytes memory hookMetadata,
                bytes32 userSalt,
                uint256 value,
                address token,
                uint256 approval
            ) = abi.decode(
                    input,
                    (
                        address,
                        uint32,
                        bytes32,
                        bytes32,
                        CallLib.Call[],
                        bytes,
                        bytes32,
                        uint256,
                        address,
                        uint256
                    )
                );
            _transientApprove(token, icaRouter, approval);
            (bool success, ) = icaRouter.call{value: value}(
                abi.encodeWithSignature(
                    "callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32)",
                    destination,
                    router,
                    ism,
                    calls,
                    hookMetadata,
                    _scopeSalt(msg.sender, userSalt)
                )
            );
            require(success, "callRemoteWithOverrides failed");
            _transientRevoke(token, icaRouter);
        } else if (command == CALL_REMOTE_COMMIT_REVEAL) {
            (
                address icaRouter,
                uint32 destination,
                bytes32 router,
                bytes32 ism,
                bytes memory hookMetadata,
                address hook,
                bytes32 salt,
                bytes32 commitment,
                uint256 value,
                address token,
                uint256 approval
            ) = abi.decode(
                    input,
                    (
                        address,
                        uint32,
                        bytes32,
                        bytes32,
                        bytes,
                        address,
                        bytes32,
                        bytes32,
                        uint256,
                        address,
                        uint256
                    )
                );
            _transientApprove(token, icaRouter, approval);
            (bool success, ) = icaRouter.call{value: value}(
                abi.encodeWithSignature(
                    "callRemoteCommitReveal(uint32,bytes32,bytes32,bytes,address,bytes32,bytes32)",
                    destination,
                    router,
                    ism,
                    hookMetadata,
                    hook,
                    _scopeSalt(msg.sender, salt),
                    commitment
                )
            );
            require(success, "callRemoteCommitReveal failed");
            _transientRevoke(token, icaRouter);
        } else if (command == SWEEP) {
            address token = abi.decode(input, (address));
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

    receive() external payable {}
}
