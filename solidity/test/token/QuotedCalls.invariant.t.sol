// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {ITokenBridge} from "../../contracts/interfaces/ITokenBridge.sol";
import {AbstractOffchainQuoter} from "../../contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../contracts/interfaces/IOffchainQuoter.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";

import {QuotedCalls} from "../../contracts/token/QuotedCalls.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Malicious contract that tries to drain QuotedCalls when called.
///      Deployed by the attacker and passed as warpRoute/icaRouter target.
contract MaliciousTarget {
    IERC20 public immutable token;
    address public immutable beneficiary;

    constructor(IERC20 _token, address _beneficiary) {
        token = _token;
        beneficiary = _beneficiary;
    }

    /// @dev When called as warpRoute.transferRemote, try to drain any
    ///      approval QuotedCalls gave us.
    function transferRemote(
        uint32,
        bytes32,
        uint256
    ) external payable returns (bytes32) {
        uint256 allowance = token.allowance(msg.sender, address(this));
        if (allowance > 0) {
            token.transferFrom(msg.sender, beneficiary, allowance);
        }
        return bytes32(0);
    }

    /// @dev When called as icaRouter.callRemoteWithOverrides
    fallback() external payable {
        uint256 allowance = token.allowance(msg.sender, address(this));
        if (allowance > 0) {
            token.transferFrom(msg.sender, beneficiary, allowance);
        }
    }

    receive() external payable {}
}

/// @dev Attacker handler that fuzzes all command types including
///      SUBMIT_QUOTE, CALL_REMOTE_WITH_OVERRIDES, and malicious targets.
contract AttackerHandler is Test {
    using TypeCasts for address;

    QuotedCalls public immutable quotedCalls;
    ERC20Test public immutable token;
    HypERC20Collateral public immutable warpRoute;
    MaliciousTarget public immutable malicious;
    address public immutable victim;

    constructor(
        QuotedCalls _quotedCalls,
        ERC20Test _token,
        HypERC20Collateral _warpRoute,
        address _victim
    ) {
        quotedCalls = _quotedCalls;
        token = _token;
        warpRoute = _warpRoute;
        victim = _victim;
        malicious = new MaliciousTarget(IERC20(address(_token)), address(this));
        token.approve(address(quotedCalls), type(uint256).max);
    }

    /// @dev Fuzz arbitrary command sequences across ALL command types.
    function executeArbitrary(
        uint8 numCmds,
        uint256[8] calldata cmdSeeds,
        uint256[8] calldata amountSeeds
    ) external {
        numCmds = uint8(bound(numCmds, 1, 8));

        bytes memory commands = new bytes(numCmds);
        bytes[] memory inputs = new bytes[](numCmds);

        for (uint256 i; i < numCmds; ++i) {
            uint256 cmdType = cmdSeeds[i] % 9;
            uint256 amount = bound(amountSeeds[i], 0, 100e18);

            if (cmdType == 0) {
                // PERMIT2_TRANSFER_FROM — pull attacker's tokens
                commands[i] = bytes1(
                    uint8(quotedCalls.PERMIT2_TRANSFER_FROM())
                );
                inputs[i] = abi.encode(address(token), amount);
            } else if (cmdType == 1) {
                // TRANSFER_REMOTE with legitimate warp route
                commands[i] = bytes1(uint8(quotedCalls.TRANSFER_REMOTE()));
                inputs[i] = abi.encode(
                    address(warpRoute),
                    uint32(12),
                    address(this).addressToBytes32(),
                    amount,
                    uint256(0), // value
                    address(token),
                    amount
                );
            } else if (cmdType == 2) {
                // TRANSFER_REMOTE with MALICIOUS warp route
                commands[i] = bytes1(uint8(quotedCalls.TRANSFER_REMOTE()));
                inputs[i] = abi.encode(
                    address(malicious),
                    uint32(12),
                    address(this).addressToBytes32(),
                    amount,
                    uint256(0), // value
                    address(token),
                    amount
                );
            } else if (cmdType == 3) {
                // TRANSFER_REMOTE with CONTRACT_BALANCE + malicious target
                commands[i] = bytes1(uint8(quotedCalls.TRANSFER_REMOTE()));
                inputs[i] = abi.encode(
                    address(malicious),
                    uint32(12),
                    address(this).addressToBytes32(),
                    amount,
                    uint256(0), // value
                    address(token),
                    quotedCalls.CONTRACT_BALANCE()
                );
            } else if (cmdType == 4) {
                // CALL_REMOTE_WITH_OVERRIDES with malicious ICA router
                CallLib.Call[] memory calls = new CallLib.Call[](0);
                commands[i] = bytes1(
                    uint8(quotedCalls.CALL_REMOTE_WITH_OVERRIDES())
                );
                inputs[i] = abi.encode(
                    address(malicious),
                    uint32(12),
                    bytes32(0),
                    bytes32(0),
                    calls,
                    "",
                    bytes32(0),
                    amount, // value
                    address(token),
                    amount // approval
                );
            } else if (cmdType == 5) {
                // SUBMIT_QUOTE with attacker as quoter (arbitrary address)
                // Salt must be keccak256(msg.sender, clientSalt)
                bytes32 clientSalt = bytes32(uint256(uint160(address(this))));
                SignedQuote memory sq = SignedQuote({
                    context: "",
                    data: "",
                    issuedAt: uint48(block.timestamp),
                    expiry: uint48(block.timestamp),
                    salt: keccak256(
                        abi.encodePacked(address(this), clientSalt)
                    ),
                    submitter: address(quotedCalls)
                });
                commands[i] = bytes1(uint8(quotedCalls.SUBMIT_QUOTE()));
                inputs[i] = abi.encode(address(malicious), sq, "", clientSalt);
            } else if (cmdType == 6) {
                // SWEEP (token + ETH)
                commands[i] = bytes1(uint8(quotedCalls.SWEEP()));
                inputs[i] = abi.encode(address(token));
            } else if (cmdType == 7) {
                // SWEEP (ETH only)
                commands[i] = bytes1(uint8(quotedCalls.SWEEP()));
                inputs[i] = abi.encode(address(0));
            } else {
                // CALL_REMOTE_COMMIT_REVEAL with malicious target
                commands[i] = bytes1(
                    uint8(quotedCalls.CALL_REMOTE_COMMIT_REVEAL())
                );
                inputs[i] = abi.encode(
                    address(malicious),
                    uint32(12),
                    bytes32(0),
                    bytes32(0),
                    "",
                    address(0),
                    bytes32(0),
                    bytes32(0),
                    amount, // value
                    address(token),
                    amount // approval
                );
            }
        }

        try quotedCalls.execute(commands, inputs) {} catch {}
    }

    /// @dev Targeted: pull tokens, approve malicious target, try to drain
    function tryMaliciousTransferRemote(uint256 amount) external {
        amount = bound(amount, 1, token.balanceOf(address(this)) / 2 + 1);
        if (token.balanceOf(address(this)) < amount) return;

        bytes memory commands = new bytes(2);
        bytes[] memory inputs = new bytes[](2);

        commands[0] = bytes1(uint8(quotedCalls.PERMIT2_TRANSFER_FROM()));
        inputs[0] = abi.encode(address(token), amount);

        commands[1] = bytes1(uint8(quotedCalls.TRANSFER_REMOTE()));
        inputs[1] = abi.encode(
            address(malicious),
            uint32(12),
            address(this).addressToBytes32(),
            amount,
            uint256(0), // value
            address(token),
            amount
        );

        try quotedCalls.execute(commands, inputs) {} catch {}
    }

    /// @dev Targeted: try to use CALL_REMOTE_WITH_OVERRIDES with malicious
    ///      router to drain via transient approval
    function tryMaliciousCallRemote(uint256 amount) external {
        amount = bound(amount, 1, token.balanceOf(address(this)) / 2 + 1);
        if (token.balanceOf(address(this)) < amount) return;

        CallLib.Call[] memory calls = new CallLib.Call[](0);

        bytes memory commands = new bytes(2);
        bytes[] memory inputs = new bytes[](2);

        commands[0] = bytes1(uint8(quotedCalls.PERMIT2_TRANSFER_FROM()));
        inputs[0] = abi.encode(address(token), amount);

        commands[1] = bytes1(uint8(quotedCalls.CALL_REMOTE_WITH_OVERRIDES()));
        inputs[1] = abi.encode(
            address(malicious),
            uint32(12),
            bytes32(0),
            bytes32(0),
            calls,
            "",
            bytes32(0),
            uint256(0),
            address(token),
            amount
        );

        try quotedCalls.execute(commands, inputs) {} catch {}
    }

    receive() external payable {}
}

contract QuotedCallsInvariantTest is Test {
    using TypeCasts for address;

    QuotedCalls quotedCalls;
    ERC20Test token;
    HypERC20Collateral warpRoute;
    AttackerHandler attacker;

    uint256 constant VICTIM_INITIAL = 500_000e18;
    uint256 constant ATTACKER_INITIAL = 10_000e18;
    address victim;

    function setUp() public {
        MockMailbox localMailbox = new MockMailbox(11);
        MockMailbox remoteMailbox = new MockMailbox(12);
        localMailbox.addRemoteMailbox(12, remoteMailbox);
        remoteMailbox.addRemoteMailbox(11, localMailbox);

        TestPostDispatchHook noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        token = new ERC20Test("Test", "TST", 1_000_000e18, 18);

        HypERC20 remoteImpl = new HypERC20(18, 1, 1, address(remoteMailbox));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(remoteImpl),
            address(0x37),
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                1_000_000e18,
                "Test",
                "TST",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        HypERC20 remoteToken = HypERC20(address(proxy));

        warpRoute = new HypERC20Collateral(
            address(token),
            1,
            1,
            address(localMailbox)
        );
        warpRoute.initialize(address(noopHook), address(0), address(this));
        warpRoute.enrollRemoteRouter(
            12,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            11,
            address(warpRoute).addressToBytes32()
        );

        GasRouter.GasRouterConfig[]
            memory gasConfigs = new GasRouter.GasRouterConfig[](1);
        gasConfigs[0] = GasRouter.GasRouterConfig({domain: 12, gas: 50_000});
        warpRoute.setDestinationGas(gasConfigs);

        quotedCalls = new QuotedCalls(IAllowanceTransfer(address(0)));

        // Victim: has tokens and a standing max ERC20 approval to QuotedCalls
        victim = address(0x71C71);
        token.transfer(victim, VICTIM_INITIAL);
        vm.prank(victim);
        token.approve(address(quotedCalls), type(uint256).max);

        // Attacker: has own tokens, own approval, and a malicious target contract
        attacker = new AttackerHandler(quotedCalls, token, warpRoute, victim);
        token.transfer(address(attacker), ATTACKER_INITIAL);
        token.transfer(address(warpRoute), 400_000e18);

        targetContract(address(attacker));
    }

    /// @dev CRITICAL: Victim's balance never decreases despite standing approval.
    function invariant_victimBalanceUnchanged() public view {
        assertEq(token.balanceOf(victim), VICTIM_INITIAL, "victim lost tokens");
    }

    /// @dev Attacker can never profit — only lose tokens to bridge/gas.
    function invariant_attackerCannotProfit() public view {
        assertLe(
            token.balanceOf(address(attacker)),
            ATTACKER_INITIAL,
            "attacker profited"
        );
    }

    /// @dev Transient approvals always revoked — checked against both the
    ///      legitimate warp route and the attacker's malicious target.
    function invariant_zeroApprovals() public view {
        assertEq(
            token.allowance(address(quotedCalls), address(warpRoute)),
            0,
            "approval to warpRoute persists"
        );
        assertEq(
            token.allowance(
                address(quotedCalls),
                address(attacker.malicious())
            ),
            0,
            "approval to malicious target persists"
        );
    }
}
