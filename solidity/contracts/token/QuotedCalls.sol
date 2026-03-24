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
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {SignedQuote, IOffchainQuoter} from "../interfaces/IOffchainQuoter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

interface ICrossCollateralRouter {
    function transferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external payable returns (bytes32);

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
contract QuotedCalls is PackageVersioned {
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
    /// @dev amount and approval resolve via _resolveAmount (supports CONTRACT_BALANCE).
    ///      value resolves native ETH to forward (supports CONTRACT_BALANCE).
    /// inputs: abi.encode(address warpRoute, uint32 destination, bytes32 recipient, uint256 amount, uint256 value, address token, uint256 approval)
    uint256 public constant TRANSFER_REMOTE = 0x04;

    /// @notice Execute a cross-collateral transferRemoteTo, approving the router first.
    /// @dev Same resolution semantics as TRANSFER_REMOTE.
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
    ) external payable {
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
        if (amount != CONTRACT_BALANCE) return amount;
        if (token == address(0)) return address(this).balance;
        return IERC20(token).balanceOf(address(this));
    }

    function _approve(address token, address spender, uint256 amount) internal {
        if (token != address(0)) IERC20(token).forceApprove(spender, amount);
    }

    function _submitQuote(bytes calldata input) internal {
        (
            address quoter,
            SignedQuote memory quote,
            bytes memory signature,
            bytes32 clientSalt
        ) = abi.decode(input, (address, SignedQuote, bytes, bytes32));
        bytes32 scopedSalt = _scopeSalt(msg.sender, clientSalt);
        if (quote.salt != scopedSalt) revert InvalidSalt();
        IOffchainQuoter(quoter).submitQuote(quote, signature);
    }

    // ============ Internal: execute dispatch ============

    function _dispatch(uint256 command, bytes calldata input) internal {
        if (command == SUBMIT_QUOTE) {
            _submitQuote(input);
        } else if (command == PERMIT2_PERMIT) {
            (
                IAllowanceTransfer.PermitSingle memory permitSingle,
                bytes memory signature
            ) = abi.decode(input, (IAllowanceTransfer.PermitSingle, bytes));
            PERMIT2.permit(msg.sender, permitSingle, signature);
        } else if (command == PERMIT2_TRANSFER_FROM) {
            (address token, uint160 amount) = abi.decode(
                input,
                (address, uint160)
            );
            PERMIT2.transferFrom(msg.sender, address(this), amount, token);
        } else if (command == TRANSFER_FROM) {
            (address token, uint256 amount) = abi.decode(
                input,
                (address, uint256)
            );
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

    function _dispatchTransferRemote(bytes calldata input) internal {
        TransferRemoteParams memory p = abi.decode(
            input,
            (TransferRemoteParams)
        );
        p.amount = _resolveAmount(p.token, p.amount);
        p.value = _resolveAmount(address(0), p.value);
        _approve(p.token, p.warpRoute, _resolveAmount(p.token, p.approval));
        ITokenBridge(p.warpRoute).transferRemote{value: p.value}(
            p.destination,
            p.recipient,
            p.amount
        );
    }

    function _dispatchTransferRemoteTo(bytes calldata input) internal {
        TransferRemoteToParams memory p = abi.decode(
            input,
            (TransferRemoteToParams)
        );
        p.amount = _resolveAmount(p.token, p.amount);
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
        value = _resolveAmount(address(0), value);
        approval = _resolveAmount(token, approval);
        _approve(token, icaRouter, approval);
        IInterchainAccountRouter(icaRouter).callRemoteWithOverrides{
            value: value
        }(
            destination,
            router,
            ism,
            calls,
            hookMetadata,
            _scopeSalt(msg.sender, userSalt)
        );
    }

    function _dispatchCallRemoteCommitReveal(bytes calldata input) internal {
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
        value = _resolveAmount(address(0), value);
        approval = _resolveAmount(token, approval);
        _approve(token, icaRouter, approval);
        IInterchainAccountRouter(icaRouter).callRemoteCommitReveal{
            value: value
        }(
            destination,
            router,
            ism,
            hookMetadata,
            IPostDispatchHook(hook),
            _scopeSalt(msg.sender, salt),
            commitment
        );
    }

    // ============ Internal: quote dispatch ============

    function _dispatchQuote(
        uint256 command,
        bytes calldata input
    ) internal returns (Quote[] memory) {
        if (command == SUBMIT_QUOTE) {
            _submitQuote(input);
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
        return new Quote[](0);
    }

    function _quoteTransferRemote(
        bytes calldata input
    ) internal view returns (Quote[] memory) {
        (
            address warpRoute,
            uint32 destination,
            bytes32 recipient,
            uint256 amount,
            ,
            ,

        ) = abi.decode(
                input,
                (address, uint32, bytes32, uint256, uint256, address, uint256)
            );
        return
            ITokenBridge(warpRoute).quoteTransferRemote(
                destination,
                recipient,
                amount
            );
    }

    function _quoteTransferRemoteTo(
        bytes calldata input
    ) internal view returns (Quote[] memory) {
        (
            address router,
            uint32 destination,
            bytes32 recipient,
            uint256 amount,
            bytes32 targetRouter,
            ,
            ,

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
        return
            ICrossCollateralRouter(router).quoteTransferRemoteTo(
                destination,
                recipient,
                amount,
                targetRouter
            );
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
        (
            address icaRouter,
            uint32 destination,
            ,
            ,
            ,
            bytes memory hookMetadata,
            ,
            ,
            address token,

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
        return _quoteIcaGasPayment(icaRouter, destination, hookMetadata, token);
    }

    function _quoteCallRemoteCommitReveal(
        bytes calldata input
    ) internal view returns (Quote[] memory) {
        (
            address icaRouter,
            uint32 destination,
            ,
            ,
            bytes memory hookMetadata,
            ,
            ,
            ,
            ,
            address token,

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
        return _quoteIcaGasPayment(icaRouter, destination, hookMetadata, token);
    }

    receive() external payable {}
}
