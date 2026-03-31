// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {ITokenBridge} from "../../contracts/interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";

import {AbstractOffchainQuoter} from "../../contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../contracts/interfaces/IOffchainQuoter.sol";
import {OffchainQuotedLinearFee, FeeQuoteContext, FeeQuoteData} from "../../contracts/token/fees/OffchainQuotedLinearFee.sol";
import {IGPQuoteContext, IGPQuoteData} from "../../contracts/hooks/igp/OffchainQuotedIGP.sol";
import {QuotedCalls} from "../../contracts/token/QuotedCalls.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {InterchainAccountRouter} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "../../contracts/libs/ReentrancyGuardTransient.sol";

/// @dev Contract that attempts reentrancy via the SWEEP ETH callback.
contract ReentrantAttacker {
    QuotedCalls target;
    bool attacked;
    bytes public reentrantRevertReason;

    constructor(QuotedCalls _target) {
        target = _target;
    }

    function attack() external payable {
        // Execute a SWEEP that sends ETH to this contract, triggering receive()
        bytes memory commands = hex"08"; // SWEEP
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(0));
        target.execute{value: msg.value}(commands, inputs);
    }

    receive() external payable {
        if (!attacked) {
            attacked = true;
            // Re-enter execute during ETH sweep
            bytes memory commands = hex"08"; // SWEEP
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(address(0));
            (bool success, bytes memory reason) = address(target).call(
                abi.encodeCall(target.execute, (commands, inputs))
            );
            require(!success, "reentrancy should have reverted");
            reentrantRevertReason = reason;
        }
    }
}

/// @dev Minimal mock Permit2. Skips signature verification; just sets allowances and transfers.
contract MockPermit2 {
    // owner => token => spender => amount
    mapping(address => mapping(address => mapping(address => uint160)))
        public allowances;

    function permit(
        address owner,
        IAllowanceTransfer.PermitSingle calldata permitSingle,
        bytes calldata
    ) external {
        allowances[owner][permitSingle.details.token][
            permitSingle.spender
        ] = permitSingle.details.amount;
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        uint160 allowed = allowances[from][token][msg.sender];
        if (allowed != type(uint160).max) {
            require(allowed >= amount, "insufficient allowance");
            allowances[from][token][msg.sender] = allowed - amount;
        }
        IERC20(token).transferFrom(from, to, amount);
    }
}

contract QuotedCallsTest is Test {
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant SCALE = 1;
    uint8 constant DECIMALS = 18;
    uint256 constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 constant TRANSFER_AMT = 100e18;
    uint256 constant MAX_FEE = 0.01 ether;
    uint256 constant HALF_AMOUNT = 0.5 ether;
    uint256 constant GAS_LIMIT = 50_000;
    uint96 constant GAS_OVERHEAD = 10_000;
    uint128 constant ORACLE_EXCHANGE_RATE = 1e10;
    uint128 constant ORACLE_GAS_PRICE = 10;
    uint128 constant OFFCHAIN_EXCHANGE_RATE = 2e10;
    uint128 constant OFFCHAIN_GAS_PRICE = 20;
    address constant ALICE = address(0x1);
    address constant BOB = address(0x2);
    address constant PROXY_ADMIN = address(0x37);

    uint256 signerPk = 0xA11CE;
    address signer;

    MockPermit2 permit2;
    ERC20Test primaryToken;
    HypERC20Collateral localToken;
    HypERC20 remoteToken;
    MockMailbox localMailbox;
    MockMailbox remoteMailbox;
    TestPostDispatchHook noopHook;
    InterchainGasPaymaster igp;
    StorageGasOracle gasOracle;
    OffchainQuotedLinearFee quotedFee;
    QuotedCalls quotedCalls;

    function setUp() public {
        signer = vm.addr(signerPk);
        CLIENT_SALT = bytes32(uint256(uint160(address(this))));

        permit2 = new MockPermit2();

        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        primaryToken = new ERC20Test("Test", "TST", TOTAL_SUPPLY, DECIMALS);

        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), address(this));
        igp.addQuoteSigner(signer);

        gasOracle = new StorageGasOracle();
        StorageGasOracle.RemoteGasDataConfig[]
            memory configs = new StorageGasOracle.RemoteGasDataConfig[](1);
        configs[0] = StorageGasOracle.RemoteGasDataConfig({
            remoteDomain: DESTINATION,
            tokenExchangeRate: ORACLE_EXCHANGE_RATE,
            gasPrice: ORACLE_GAS_PRICE
        });
        gasOracle.setRemoteGasDataConfigs(configs);

        InterchainGasPaymaster.GasParam[]
            memory gasParams = new InterchainGasPaymaster.GasParam[](1);
        gasParams[0] = InterchainGasPaymaster.GasParam({
            remoteDomain: DESTINATION,
            config: InterchainGasPaymaster.DomainGasConfig({
                gasOracle: gasOracle,
                gasOverhead: GAS_OVERHEAD
            })
        });
        igp.setDestinationGasConfigs(gasParams);

        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory tokenConfigs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        tokenConfigs[0] = InterchainGasPaymaster.TokenGasOracleConfig({
            feeToken: address(primaryToken),
            remoteDomain: DESTINATION,
            gasOracle: gasOracle
        });
        igp.setTokenGasOracles(tokenConfigs);

        HypERC20 remoteImpl = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(remoteImpl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                "Test",
                "TST",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));

        localToken = new HypERC20Collateral(
            address(primaryToken),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        localToken.initialize(address(noopHook), address(0), address(this));

        quotedFee = new OffchainQuotedLinearFee(
            signer,
            address(primaryToken),
            MAX_FEE,
            HALF_AMOUNT,
            signer
        );
        localToken.setFeeRecipient(address(quotedFee));

        localToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );

        GasRouter.GasRouterConfig[]
            memory gasRouterConfigs = new GasRouter.GasRouterConfig[](1);
        gasRouterConfigs[0] = GasRouter.GasRouterConfig({
            domain: DESTINATION,
            gas: GAS_LIMIT
        });
        localToken.setDestinationGas(gasRouterConfigs);

        primaryToken.transfer(ALICE, 1000e18);
        primaryToken.transfer(address(localToken), 1000e18);

        quotedCalls = new QuotedCalls(IAllowanceTransfer(address(permit2)));

        // ALICE approves MockPermit2 for token pulls (one-time)
        vm.prank(ALICE);
        primaryToken.approve(address(permit2), type(uint256).max);
    }

    // ============ Helpers ============

    function _domainSeparator(
        address verifier
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("OffchainQuoter"),
                    keccak256("1"),
                    block.chainid,
                    verifier
                )
            );
    }

    function _signQuote(
        address verifier,
        SignedQuote memory sq
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                quotedFee.SIGNED_QUOTE_TYPEHASH(),
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(
            _domainSeparator(verifier),
            structHash
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    bytes32 CLIENT_SALT;

    function _scopedSalt(address caller) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(caller, CLIENT_SALT));
    }

    function _feeQuoteContext() internal pure returns (bytes memory) {
        return
            FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                TRANSFER_AMT
            );
    }

    function _buildFeeQuote(
        address caller
    ) internal view returns (bytes memory) {
        return _buildFeeQuote(true, caller);
    }

    function _buildFeeQuote(
        bool transient_,
        address caller
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        // Standing quotes must use wildcard amount (linear fee scales with any amount)
        bytes memory context = transient_
            ? _feeQuoteContext()
            : FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                type(uint256).max
            );
        SignedQuote memory sq = SignedQuote({
            context: context,
            data: FeeQuoteData.encode(MAX_FEE, HALF_AMOUNT),
            issuedAt: now_,
            expiry: transient_ ? now_ : now_ + 3600,
            salt: _scopedSalt(caller),
            submitter: address(quotedCalls)
        });
        return
            abi.encode(
                address(quotedFee),
                sq,
                _signQuote(address(quotedFee), sq),
                CLIENT_SALT
            );
    }

    function _encodeGasData(
        uint128 exchangeRate,
        uint128 gasPrice
    ) internal pure returns (bytes memory) {
        return IGPQuoteData.encode(exchangeRate, gasPrice);
    }

    function _buildIgpQuote(
        address caller
    ) internal view returns (bytes memory) {
        return
            _buildIgpQuote(
                true,
                caller,
                address(primaryToken),
                address(localToken)
            );
    }

    function _buildIgpQuote(
        address caller,
        address feeToken,
        address sender
    ) internal view returns (bytes memory) {
        return _buildIgpQuote(true, caller, feeToken, sender);
    }

    function _buildIgpQuote(
        bool transient_,
        address caller,
        address feeToken,
        address sender
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: IGPQuoteContext.encode(feeToken, DESTINATION, sender),
            data: _encodeGasData(OFFCHAIN_EXCHANGE_RATE, OFFCHAIN_GAS_PRICE),
            issuedAt: now_,
            expiry: transient_ ? now_ : now_ + 3600,
            salt: _scopedSalt(caller),
            submitter: address(quotedCalls)
        });
        return
            abi.encode(
                address(igp),
                sq,
                _signQuote(address(igp), sq),
                CLIENT_SALT
            );
    }

    function _computeOffchainIgpFee() internal view returns (uint256) {
        return _computeOffchainIgpFee(GAS_LIMIT);
    }

    function _computeOffchainIgpFee(
        uint256 gasLimit
    ) internal view returns (uint256) {
        uint256 totalGas = igp.destinationGasLimit(DESTINATION, gasLimit);
        return
            (totalGas *
                uint256(OFFCHAIN_GAS_PRICE) *
                uint256(OFFCHAIN_EXCHANGE_RATE)) / 1e10;
    }

    // ============ Command Builders ============

    function _cmdSubmitQuote(
        bytes memory quoteInput
    ) internal view returns (bytes1, bytes memory) {
        return (bytes1(uint8(quotedCalls.SUBMIT_QUOTE())), quoteInput);
    }

    function _cmdPermit2Permit(
        IAllowanceTransfer.PermitSingle memory permitSingle,
        bytes memory signature
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.PERMIT2_PERMIT())),
            abi.encode(permitSingle, signature)
        );
    }

    function _cmdPermit2TransferFrom(
        address token,
        uint160 amount
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.PERMIT2_TRANSFER_FROM())),
            abi.encode(token, amount)
        );
    }

    function _cmdTransferFrom(
        address token,
        uint256 amount
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.TRANSFER_FROM())),
            abi.encode(token, amount)
        );
    }

    function _cmdTransferRemote(
        address warpRoute,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        uint256 value,
        address token,
        uint256 approval
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.TRANSFER_REMOTE())),
            abi.encode(
                warpRoute,
                destination,
                recipient,
                amount,
                value,
                token,
                approval
            )
        );
    }

    function _cmdTransferRemoteTo(
        address router,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        bytes32 targetRouter,
        uint256 value,
        address token,
        uint256 approval
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.TRANSFER_REMOTE_TO())),
            abi.encode(
                router,
                destination,
                recipient,
                amount,
                targetRouter,
                value,
                token,
                approval
            )
        );
    }

    function _cmdCallRemoteWithOverrides(
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
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.CALL_REMOTE_WITH_OVERRIDES())),
            abi.encode(
                icaRouter,
                destination,
                router,
                ism,
                calls,
                hookMetadata,
                userSalt,
                value,
                token,
                approval
            )
        );
    }

    function _cmdCallRemoteCommitReveal(
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
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.CALL_REMOTE_COMMIT_REVEAL())),
            abi.encode(
                icaRouter,
                destination,
                router,
                ism,
                hookMetadata,
                hook,
                salt,
                commitment,
                value,
                token,
                approval
            )
        );
    }

    function _cmdSweep(
        address token
    ) internal view returns (bytes1, bytes memory) {
        return (bytes1(uint8(quotedCalls.SWEEP())), abi.encode(token));
    }

    function _pack(
        bytes1[] memory cmds,
        bytes[] memory ins
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        commands = new bytes(cmds.length);
        for (uint256 i; i < cmds.length; ++i) {
            commands[i] = cmds[i];
        }
        inputs = ins;
    }

    // ============ Tests: ERC20 transferFrom path ============

    /// @dev ALICE approves QuotedCalls directly — ERC20 transferFrom succeeds on first try
    function test_transferFrom_erc20Path() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        // Direct ERC20 approval — transferFrom succeeds without Permit2
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        // Permit2 allowance untouched (ERC20 path was used)
        assertEq(
            permit2.allowances(
                ALICE,
                address(primaryToken),
                address(quotedCalls)
            ),
            0
        );
    }

    // ============ Tests: Permit2 fallback path ============

    /// @dev No direct ERC20 approval to QuotedCalls — ERC20 transferFrom fails,
    ///      falls back to Permit2 which has allowance via PERMIT2_PERMIT
    function test_permit2TransferFrom() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        IAllowanceTransfer.PermitSingle memory permitSingle = IAllowanceTransfer
            .PermitSingle({
                details: IAllowanceTransfer.PermitDetails({
                    token: address(primaryToken),
                    amount: uint160(totalTokens),
                    expiration: uint48(block.timestamp + 3600),
                    nonce: 0
                }),
                spender: address(quotedCalls),
                sigDeadline: block.timestamp + 3600
            });

        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdPermit2Permit(permitSingle, "");
        (cmds[2], ins[2]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            uint160(totalTokens)
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        // No direct ERC20 approval to QuotedCalls — only Permit2
        vm.prank(ALICE);
        quotedCalls.execute(commands, inputs);

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        // Permit2 allowance was consumed
        assertEq(
            permit2.allowances(
                ALICE,
                address(primaryToken),
                address(quotedCalls)
            ),
            0
        );
    }

    // ============ Tests: CONTRACT_BALANCE sentinel ============

    /// @dev Pull exact amount, then use CONTRACT_BALANCE for transferRemote
    ///      so it bridges whatever is left after fees
    function test_transferRemote_withContractBalance() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        // Use CONTRACT_BALANCE for approval — resolves to the full contract
        // balance so the warp route can pull transfer amount + fees
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            CONTRACT_BAL
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    /// @dev Use CONTRACT_BALANCE for native value — resolves to contract's ETH balance
    function test_transferRemote_withNativeContractBalance() public {
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();
        uint256 nativeValue = 1 ether;
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        // value = CONTRACT_BALANCE resolves to address(this).balance
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            CONTRACT_BAL,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, nativeValue);
        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute{value: nativeValue}(commands, inputs);
        vm.stopPrank();

        // native ETH was forwarded to the warp route
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: No Quotes Reverts ============

    function test_execute_noQuotes_reverts() public {
        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdTransferFrom(
            address(primaryToken),
            TRANSFER_AMT
        );
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            TRANSFER_AMT
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), TRANSFER_AMT);
        vm.expectRevert();
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();
    }

    // ============ Tests: IGP + Fee Quote ============

    function test_execute_withIgpAndFeeQuotes() public {
        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 igpFee = _computeOffchainIgpFee();
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE + igpFee;

        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildIgpQuote(ALICE));
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[2], ins[2]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(igp)), igpFee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Multi-Call with ICA + Warp ============

    function test_execute_withIcaAndWarpQuotes() public {
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 warpIgpFee = _computeOffchainIgpFee();
        uint256 icaNativeFee = _computeOffchainIgpFee(50_000);
        uint256 totalERC20 = TRANSFER_AMT + MAX_FEE + warpIgpFee;

        CallLib.Call[] memory remoteIcaCalls = new CallLib.Call[](1);
        remoteIcaCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });

        bytes memory hookMetadata = StandardHookMetadata.format(
            icaNativeFee,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](7);
        bytes[] memory ins = new bytes[](7);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(primaryToken), address(localToken))
        );
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[2], ins[2]) = _cmdTransferFrom(address(primaryToken), totalERC20);
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalERC20
        );
        (cmds[4], ins[4]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(0), address(icaRouter))
        );
        (cmds[5], ins[5]) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            remoteIcaCalls,
            hookMetadata,
            bytes32(0),
            icaNativeFee,
            address(0),
            0
        );
        (cmds[6], ins[6]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, icaNativeFee);
        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalERC20);
        quotedCalls.execute{value: icaNativeFee}(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalERC20);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(igp)), warpIgpFee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        assertEq(address(igp).balance, icaNativeFee);
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: ICA with CONTRACT_BALANCE ============

    /// @dev Use CONTRACT_BALANCE for ICA native value and ERC20 approval
    function test_callRemote_withContractBalance() public {
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();

        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 icaNativeFee = _computeOffchainIgpFee(50_000);

        CallLib.Call[] memory remoteIcaCalls = new CallLib.Call[](1);
        remoteIcaCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });

        bytes memory hookMetadata = StandardHookMetadata.format(
            icaNativeFee,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(0), address(icaRouter))
        );
        // CONTRACT_BALANCE for both native value and approval
        (cmds[1], ins[1]) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            remoteIcaCalls,
            hookMetadata,
            bytes32(0),
            CONTRACT_BAL, // value resolves to address(this).balance
            address(0),
            0
        );
        (cmds[2], ins[2]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, icaNativeFee);
        vm.startPrank(ALICE);
        quotedCalls.execute{value: icaNativeFee}(commands, inputs);
        vm.stopPrank();

        assertEq(address(igp).balance, icaNativeFee);
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: Standing Quotes ============

    function test_execute_withStandingFeeQuote() public {
        bytes1[] memory setupCmds = new bytes1[](1);
        bytes[] memory setupIns = new bytes[](1);
        (setupCmds[0], setupIns[0]) = _cmdSubmitQuote(
            _buildFeeQuote(false, address(this))
        );
        (bytes memory setupCommands, bytes[] memory setupInputs) = _pack(
            setupCmds,
            setupIns
        );
        quotedCalls.execute(setupCommands, setupInputs);

        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Salt Validation ============

    function test_execute_wrongSalt_reverts() public {
        bytes1[] memory cmds = new bytes1[](1);
        bytes[] memory ins = new bytes[](1);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.expectRevert(QuotedCalls.InvalidSalt.selector);
        quotedCalls.execute(commands, inputs);
    }

    // ============ Tests: Invalid Command ============

    function test_execute_invalidCommand_reverts() public {
        bytes memory commands = hex"ff";
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = "";

        vm.expectRevert(
            abi.encodeWithSelector(QuotedCalls.InvalidCommandType.selector, 255)
        );
        quotedCalls.execute(commands, inputs);
    }

    // ============ Tests: CALL_REMOTE_COMMIT_REVEAL ============

    function test_callRemoteCommitReveal_happyPath() public {
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        // commit-reveal dispatches two messages:
        // commit uses COMMIT_TX_GAS_USAGE (0) + overhead, reveal uses 50k + overhead
        uint256 commitFee = _computeOffchainIgpFee(0);
        uint256 revealFee = _computeOffchainIgpFee(50_000);
        uint256 totalNativeFee = commitFee + revealFee;
        bytes32 commitment = keccak256("test commitment");
        bytes32 userSalt = bytes32(uint256(42));

        bytes memory hookMetadata = StandardHookMetadata.format(
            revealFee,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(0), address(icaRouter))
        );
        (cmds[1], ins[1]) = _cmdCallRemoteCommitReveal(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            hookMetadata,
            address(igp),
            userSalt,
            commitment,
            totalNativeFee,
            address(0),
            0
        );
        (cmds[2], ins[2]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, totalNativeFee);
        vm.startPrank(ALICE);
        quotedCalls.execute{value: totalNativeFee}(commands, inputs);
        vm.stopPrank();

        assertEq(address(igp).balance, totalNativeFee);
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: SWEEP with token = address(0) ============

    function test_sweep_ethOnly() public {
        uint256 ethAmount = 1 ether;

        // Send some tokens AND ETH to quotedCalls
        primaryToken.transfer(address(quotedCalls), 10e18);
        vm.deal(address(quotedCalls), ethAmount);

        bytes1[] memory cmds = new bytes1[](1);
        bytes[] memory ins = new bytes[](1);
        (cmds[0], ins[0]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        uint256 aliceEthBefore = ALICE.balance;
        uint256 aliceTokenBefore = primaryToken.balanceOf(ALICE);

        vm.prank(ALICE);
        quotedCalls.execute(commands, inputs);

        // ETH swept to ALICE
        assertEq(ALICE.balance, aliceEthBefore + ethAmount);
        // Tokens NOT swept (token = address(0) skips ERC20)
        assertEq(primaryToken.balanceOf(ALICE), aliceTokenBefore);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 10e18);
    }

    // ============ Tests: Persistent Approval Reuse ============

    function test_persistentApproval_reusedAcrossCalls() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        // First execute: sets approval from quotedCalls to localToken
        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens * 2);

        quotedCalls.execute(commands, inputs);

        // Second execute reuses the persistent approval
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );
        (commands, inputs) = _pack(cmds, ins);

        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens * 2);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Revert Midway is Atomic ============

    function test_revertMidway_atomicRollback() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        // cmd 0: pull tokens (succeeds)
        (cmds[0], ins[0]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        // cmd 1: submit quote (succeeds)
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        // cmd 2: invalid command (reverts)
        cmds[2] = bytes1(uint8(0xff));
        ins[2] = "";

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        uint256 aliceBefore = primaryToken.balanceOf(ALICE);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        vm.expectRevert(
            abi.encodeWithSelector(QuotedCalls.InvalidCommandType.selector, 255)
        );
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        // Atomic revert — ALICE balance unchanged
        assertEq(primaryToken.balanceOf(ALICE), aliceBefore);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Multiple SUBMIT_QUOTE Interleaving ============

    function test_multipleQuotes_secondOverwritesFirst() public {
        // Build two fee quotes with different params
        uint256 firstMaxFee = 0.01 ether;
        uint256 secondMaxFee = 0.005 ether;

        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq1 = SignedQuote({
            context: _feeQuoteContext(),
            data: FeeQuoteData.encode(firstMaxFee, HALF_AMOUNT),
            issuedAt: now_,
            expiry: now_,
            salt: _scopedSalt(ALICE),
            submitter: address(quotedCalls)
        });
        bytes memory quote1Input = abi.encode(
            address(quotedFee),
            sq1,
            _signQuote(address(quotedFee), sq1),
            CLIENT_SALT
        );

        SignedQuote memory sq2 = SignedQuote({
            context: _feeQuoteContext(),
            data: FeeQuoteData.encode(secondMaxFee, HALF_AMOUNT),
            issuedAt: now_,
            expiry: now_,
            salt: _scopedSalt(ALICE),
            submitter: address(quotedCalls)
        });
        bytes memory quote2Input = abi.encode(
            address(quotedFee),
            sq2,
            _signQuote(address(quotedFee), sq2),
            CLIENT_SALT
        );

        uint256 totalTokens = TRANSFER_AMT + secondMaxFee;

        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(quote1Input);
        // Second quote overwrites first in transient storage
        (cmds[1], ins[1]) = _cmdSubmitQuote(quote2Input);
        (cmds[2], ins[2]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        // Fee charged at second quote's rate
        assertEq(primaryToken.balanceOf(address(quotedFee)), secondMaxFee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: quoteExecute ============

    /// @dev Sum Quote[][] into totals per token address
    function _sumQuotes(
        Quote[][] memory results
    )
        internal
        pure
        returns (uint256 nativeTotal, uint256 tokenTotal, address tokenAddr)
    {
        for (uint256 i; i < results.length; ++i) {
            for (uint256 j; j < results[i].length; ++j) {
                if (results[i][j].token == address(0)) {
                    nativeTotal += results[i][j].amount;
                } else {
                    tokenTotal += results[i][j].amount;
                    tokenAddr = results[i][j].token;
                }
            }
        }
    }

    /// @dev quoteExecute with TRANSFER_REMOTE returns per-command Quote[][]
    function test_quoteExecute_transferRemote() public {
        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(address(this)));
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);

        // cmd[0]=SUBMIT_QUOTE → empty, cmd[1]=TRANSFER_REMOTE → 3 quotes
        assertEq(results[0].length, 0, "SUBMIT_QUOTE returns no quotes");
        assertEq(results[1].length, 3, "TRANSFER_REMOTE returns 3 quotes");
        (, uint256 tokenTotal, ) = _sumQuotes(results);
        assertGt(tokenTotal, TRANSFER_AMT, "token total should include fee");
    }

    /// @dev quoteExecute with TRANSFER_REMOTE using ERC20 IGP fee token
    function test_quoteExecute_transferRemote_erc20Igp() public {
        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(
                address(this),
                address(primaryToken),
                address(localToken)
            )
        );
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(address(this)));
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);

        // cmd[2]=TRANSFER_REMOTE has the quotes
        assertEq(results[2].length, 3, "TRANSFER_REMOTE returns 3 quotes");
        (, uint256 tokenTotal, ) = _sumQuotes(results);
        assertGt(tokenTotal, TRANSFER_AMT, "token total should include fees");
    }

    /// @dev quoteExecute with CALL_REMOTE_WITH_OVERRIDES returns ICA gas quote
    function test_quoteExecute_callRemoteWithOverrides() public {
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        CallLib.Call[] memory remoteCalls = new CallLib.Call[](1);
        remoteCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });

        bytes memory hookMetadata = StandardHookMetadata.format(
            0,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(address(this), address(0), address(icaRouter))
        );
        (cmds[1], ins[1]) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            remoteCalls,
            hookMetadata,
            bytes32(0),
            0,
            address(0),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);

        assertEq(results[1].length, 1, "ICA should return 1 quote");
        assertEq(results[1][0].token, address(0), "ICA fee should be native");
        assertGt(results[1][0].amount, 0, "ICA fee should be > 0");
    }

    /// @dev quoteExecute with CALL_REMOTE_COMMIT_REVEAL returns ICA gas quote
    function test_quoteExecute_callRemoteCommitReveal() public {
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        bytes memory hookMetadata = StandardHookMetadata.format(
            0,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(address(this), address(0), address(icaRouter))
        );
        (cmds[1], ins[1]) = _cmdCallRemoteCommitReveal(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            hookMetadata,
            address(noopHook),
            bytes32(0),
            keccak256("commitment"),
            0,
            address(0),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);

        assertEq(results[1].length, 1, "commit-reveal should return 1 quote");
        assertEq(results[1][0].token, address(0), "fee should be native");
        assertGt(results[1][0].amount, 0, "fee should be > 0");
    }

    /// @dev quoteExecute skips TRANSFER_FROM, PERMIT2, and SWEEP commands
    function test_quoteExecute_skipsTokenOps() public {
        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdTransferFrom(address(primaryToken), 100e18);
        (cmds[1], ins[1]) = _cmdSweep(address(primaryToken));
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        // Should not revert despite no approvals — TRANSFER_FROM is skipped
        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);
        assertEq(results[0].length, 0, "TRANSFER_FROM skipped");
        assertEq(results[1].length, 0, "SWEEP skipped");
        assertEq(results[2].length, 3, "TRANSFER_REMOTE returns quotes");
    }

    /// @dev quoteExecute with vs without SUBMIT_QUOTE — offchain quotes
    ///      produce different fees than the onchain oracle fallback.
    function test_quoteExecute_withVsWithoutSubmitQuote() public {
        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        // Shared TRANSFER_REMOTE input
        (bytes1 trCmd, bytes memory trInput) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            0
        );

        // Without SUBMIT_QUOTE — uses oracle fallback
        {
            bytes1[] memory cmds = new bytes1[](1);
            bytes[] memory ins = new bytes[](1);
            cmds[0] = trCmd;
            ins[0] = trInput;
            (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

            Quote[][] memory fallbackResults = quotedCalls.quoteExecute(
                commands,
                inputs
            );
            (, uint256 fallbackTokenTotal, ) = _sumQuotes(fallbackResults);
            assertGt(fallbackTokenTotal, 0, "fallback should quote nonzero");

            // With SUBMIT_QUOTE — uses offchain rates (2x oracle)
            bytes1[] memory cmds2 = new bytes1[](3);
            bytes[] memory ins2 = new bytes[](3);
            (cmds2[0], ins2[0]) = _cmdSubmitQuote(
                _buildIgpQuote(
                    address(this),
                    address(primaryToken),
                    address(localToken)
                )
            );
            (cmds2[1], ins2[1]) = _cmdSubmitQuote(
                _buildFeeQuote(address(this))
            );
            cmds2[2] = trCmd;
            ins2[2] = trInput;
            (bytes memory commands2, bytes[] memory inputs2) = _pack(
                cmds2,
                ins2
            );

            Quote[][] memory quotedResults = quotedCalls.quoteExecute(
                commands2,
                inputs2
            );
            (, uint256 quotedTokenTotal, ) = _sumQuotes(quotedResults);
            assertGt(quotedTokenTotal, 0, "quoted should quote nonzero");

            // Offchain IGP rate is 2x oracle → different total
            assertTrue(
                quotedTokenTotal != fallbackTokenTotal,
                "offchain quotes should differ from oracle fallback"
            );
        }
    }

    // ============ Fuzz: quoteExecute → execute round-trip ============

    function _buildFeeQuoteForAmount(
        uint256 amount,
        address caller
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                amount
            ),
            data: FeeQuoteData.encode(MAX_FEE, HALF_AMOUNT),
            issuedAt: now_,
            expiry: now_,
            salt: _scopedSalt(caller),
            submitter: address(quotedCalls)
        });
        return
            abi.encode(
                address(quotedFee),
                sq,
                _signQuote(address(quotedFee), sq),
                CLIENT_SALT
            );
    }

    function _quoteTransfer(
        uint256 transferAmt,
        bytes memory feeQuoteInput
    ) internal returns (Quote[][] memory) {
        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdSubmitQuote(feeQuoteInput);
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            transferAmt,
            0,
            address(primaryToken),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);
        return quotedCalls.quoteExecute(commands, inputs);
    }

    function _executeTransfer(
        uint256 transferAmt,
        uint256 totalTokenNeeded,
        uint256 totalNativeNeeded,
        bytes memory feeQuoteInput
    ) internal {
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();
        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(feeQuoteInput);
        (cmds[1], ins[1]) = _cmdTransferFrom(
            address(primaryToken),
            totalTokenNeeded
        );
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            transferAmt,
            CONTRACT_BAL,
            address(primaryToken),
            CONTRACT_BAL
        );
        (cmds[3], ins[3]) = _cmdSweep(address(primaryToken));
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        primaryToken.approve(address(quotedCalls), totalTokenNeeded);
        vm.deal(ALICE, totalNativeNeeded);
        quotedCalls.execute{value: totalNativeNeeded}(commands, inputs);
    }

    /// @dev Fuzz transfer amount, use quoteExecute to determine fees for
    ///      both a warp TRANSFER_REMOTE and ICA CALL_REMOTE, then execute
    ///      the full sequence — as the offchain client would.
    function test_fuzz_quoteExecuteThenExecute(uint256 transferAmt) public {
        transferAmt = bound(transferAmt, 1, 500e18);

        // Setup: ERC20 IGP for warp route, native IGP for ICA
        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        CallLib.Call[] memory remoteCalls = new CallLib.Call[](1);
        remoteCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });
        bytes memory hookMetadata = StandardHookMetadata.format(
            0,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes memory warpFeeQuote = _buildFeeQuoteForAmount(transferAmt, ALICE);
        bytes memory warpIgpQuote = _buildIgpQuote(
            ALICE,
            address(primaryToken),
            address(localToken)
        );
        bytes memory icaIgpQuote = _buildIgpQuote(
            ALICE,
            address(0),
            address(icaRouter)
        );

        vm.startPrank(ALICE);

        // Step 1: quoteExecute — same commands, no TRANSFER_FROM/SWEEP
        //   [0] SUBMIT_QUOTE  (warp IGP)
        //   [1] SUBMIT_QUOTE  (warp fee)
        //   [2] TRANSFER_REMOTE
        //   [3] SUBMIT_QUOTE  (ICA IGP)
        //   [4] CALL_REMOTE_WITH_OVERRIDES
        {
            bytes1[] memory qCmds = new bytes1[](5);
            bytes[] memory qIns = new bytes[](5);
            (qCmds[0], qIns[0]) = _cmdSubmitQuote(warpIgpQuote);
            (qCmds[1], qIns[1]) = _cmdSubmitQuote(warpFeeQuote);
            (qCmds[2], qIns[2]) = _cmdTransferRemote(
                address(localToken),
                DESTINATION,
                BOB.addressToBytes32(),
                transferAmt,
                0,
                address(primaryToken),
                0
            );
            (qCmds[3], qIns[3]) = _cmdSubmitQuote(icaIgpQuote);
            (qCmds[4], qIns[4]) = _cmdCallRemoteWithOverrides(
                address(icaRouter),
                DESTINATION,
                address(0xdead).addressToBytes32(),
                bytes32(0),
                remoteCalls,
                hookMetadata,
                bytes32(0),
                0,
                address(0),
                0
            );
            (bytes memory commands, bytes[] memory inputs) = _pack(qCmds, qIns);

            Quote[][] memory results = quotedCalls.quoteExecute(
                commands,
                inputs
            );

            // results[i] corresponds to commands[i]
            assertEq(results[0].length, 0, "[0] SUBMIT_QUOTE: no quotes");
            assertEq(results[1].length, 0, "[1] SUBMIT_QUOTE: no quotes");
            assertGt(results[2].length, 0, "[2] TRANSFER_REMOTE: has quotes");
            assertEq(results[3].length, 0, "[3] SUBMIT_QUOTE: no quotes");
            assertEq(results[4].length, 1, "[4] CALL_REMOTE: 1 quote");

            (totalNativeNeeded, totalTokenNeeded, ) = _sumQuotes(results);
        }

        // Step 2: execute with quoted amounts — insert TRANSFER_FROM + SWEEP
        uint256 aliceBefore = primaryToken.balanceOf(ALICE);
        {
            uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();
            bytes1[] memory eCmds = new bytes1[](8);
            bytes[] memory eIns = new bytes[](8);
            // Same quote commands at same relative positions
            (eCmds[0], eIns[0]) = _cmdSubmitQuote(warpIgpQuote);
            (eCmds[1], eIns[1]) = _cmdSubmitQuote(warpFeeQuote);
            // Inserted: pull tokens using quoted amount
            (eCmds[2], eIns[2]) = _cmdTransferFrom(
                address(primaryToken),
                totalTokenNeeded
            );
            // value=0: warp route uses ERC20 IGP, not native
            (eCmds[3], eIns[3]) = _cmdTransferRemote(
                address(localToken),
                DESTINATION,
                BOB.addressToBytes32(),
                transferAmt,
                0,
                address(primaryToken),
                CONTRACT_BAL
            );
            (eCmds[4], eIns[4]) = _cmdSubmitQuote(icaIgpQuote);
            (eCmds[5], eIns[5]) = _cmdCallRemoteWithOverrides(
                address(icaRouter),
                DESTINATION,
                address(0xdead).addressToBytes32(),
                bytes32(0),
                remoteCalls,
                hookMetadata,
                bytes32(0),
                CONTRACT_BAL,
                address(0),
                0
            );
            // Inserted: sweep leftover tokens + ETH
            (eCmds[6], eIns[6]) = _cmdSweep(address(primaryToken));
            (eCmds[7], eIns[7]) = _cmdSweep(address(0));
            (bytes memory commands, bytes[] memory inputs) = _pack(eCmds, eIns);

            primaryToken.approve(address(quotedCalls), totalTokenNeeded);
            vm.deal(ALICE, totalNativeNeeded);
            quotedCalls.execute{value: totalNativeNeeded}(commands, inputs);
        }
        vm.stopPrank();

        // Verify: exact spend, nothing stuck
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBefore - totalTokenNeeded,
            "ALICE should spend exactly quoted ERC20 amount"
        );
        assertEq(
            primaryToken.balanceOf(address(quotedCalls)),
            0,
            "no tokens stuck in QuotedCalls"
        );
        assertEq(
            address(quotedCalls).balance,
            0,
            "no ETH stuck in QuotedCalls"
        );
    }
    // ============ Tests: Reentrancy Guard ============

    function test_execute_reentrancy_reverts() public {
        ReentrantAttacker attacker = new ReentrantAttacker(quotedCalls);
        vm.deal(address(attacker), 1 ether);

        // The attacker's receive() catches the revert and stores the reason
        attacker.attack{value: 1 ether}();

        assertEq(
            attacker.reentrantRevertReason(),
            abi.encodeWithSelector(
                ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
            )
        );
    }

    // Storage vars for fuzz test (avoids stack-too-deep)
    uint256 totalTokenNeeded;
    uint256 totalNativeNeeded;

    receive() external payable {}
}
