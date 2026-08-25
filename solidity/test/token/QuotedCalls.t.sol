// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
import {AbstractPostDispatchHook} from "../../contracts/hooks/libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";

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
import {InterchainAccountMessage} from "../../contracts/middleware/libs/InterchainAccountMessage.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ReentrancyGuardTransient} from "../../contracts/libs/ReentrancyGuardTransient.sol";

/// @dev ERC20 hook whose fee binds quotes to the actual metadata and complete
///      formatted message, including its sender and Mailbox nonce.
contract QuotedCallsERC20FeeHook is AbstractPostDispatchHook {
    using Message for bytes;
    using SafeERC20 for IERC20;
    using StandardHookMetadata for bytes;

    IERC20 public immutable feeToken;
    uint256 public dispatchCount;
    uint256 public totalFees;
    bytes32 public lastRecipient;

    constructor(IERC20 _feeToken) {
        feeToken = _feeToken;
    }

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.UNUSED);
    }

    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        require(
            metadata.feeToken(address(0)) == address(feeToken),
            "unexpected fee token"
        );
        uint256 fee = _quoteDispatch(metadata, message);
        feeToken.safeTransferFrom(message.senderAddress(), address(this), fee);
        dispatchCount += 1;
        totalFees += fee;
        lastRecipient = message.recipient();
    }

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal pure override returns (uint256) {
        return
            1_000_000 +
            metadata.gasLimit() +
            (uint256(message.recipient()) & 0xffff) *
            1_000_000 +
            uint256(uint72(uint256(keccak256(message))));
    }
}

/// @dev Models the ICA getter and quote surface deployed before exact-input
///      quote overloads existed.
contract LegacyIcaRouterQuoteSurface {
    using StandardHookMetadata for bytes;
    using TypeCasts for address;

    IMailbox public immutable mailbox;
    IPostDispatchHook public hook;
    uint256 public immutable COMMIT_TX_GAS_USAGE;

    constructor(
        IMailbox _mailbox,
        IPostDispatchHook _hook,
        uint256 _commitTxGasUsage
    ) {
        mailbox = _mailbox;
        hook = _hook;
        COMMIT_TX_GAS_USAGE = _commitTxGasUsage;
    }

    function quoteGasPayment(
        address,
        uint32,
        uint256
    ) external pure returns (uint256) {
        return 1;
    }

    function quoteGasForCommitReveal(
        address,
        uint32,
        uint256
    ) external pure returns (uint256) {
        return 2;
    }

    function callRemoteWithOverrides(
        uint32 destination,
        bytes32 router,
        bytes32 ism,
        CallLib.Call[] calldata calls,
        bytes calldata hookMetadata,
        bytes32 salt
    ) external payable returns (bytes32) {
        bytes memory body = InterchainAccountMessage.encode(
            msg.sender,
            ism,
            calls,
            salt
        );
        return
            mailbox.dispatch{value: msg.value}(
                destination,
                router,
                body,
                hookMetadata,
                hook
            );
    }

    function callRemoteCommitReveal(
        uint32 destination,
        bytes32 router,
        bytes32 ism,
        bytes calldata hookMetadata,
        IPostDispatchHook selectedHook,
        bytes32 salt,
        bytes32 commitment
    ) external payable returns (bytes32 commitmentId, bytes32 revealId) {
        bytes memory commitmentBody = InterchainAccountMessage
            .encodeCommitment({
                _owner: msg.sender.addressToBytes32(),
                _ism: ism,
                _commitment: commitment,
                _userSalt: salt
            });
        bytes memory commitmentMetadata = StandardHookMetadata
            .formatWithFeeToken(
                0,
                COMMIT_TX_GAS_USAGE,
                address(this),
                hookMetadata.feeToken()
            );
        commitmentId = mailbox.dispatch{value: msg.value}(
            destination,
            router,
            commitmentBody,
            commitmentMetadata,
            selectedHook
        );

        bytes memory revealBody = InterchainAccountMessage.encodeReveal({
            _ism: bytes32(0),
            _commitment: commitment
        });
        revealId = mailbox.dispatch(
            destination,
            router,
            revealBody,
            hookMetadata,
            selectedHook
        );
    }
}

contract MessageEncodingHarness {
    function icaEncodingsMatch(
        address owner,
        bytes32 ism,
        CallLib.Call[] calldata calls,
        bytes32 salt
    ) external pure returns (bool) {
        CallLib.Call[] memory memoryCalls = calls;
        return
            keccak256(
                InterchainAccountMessage.encode(owner, ism, calls, salt)
            ) ==
            keccak256(
                InterchainAccountMessage.encodeMemory(
                    owner,
                    ism,
                    memoryCalls,
                    salt
                )
            );
    }

    function messageEncodingsMatch(
        uint8 version,
        uint32 nonce,
        uint32 origin,
        bytes32 sender,
        uint32 destination,
        bytes32 recipient,
        bytes calldata body
    ) external pure returns (bool) {
        bytes memory memoryBody = body;
        return
            keccak256(
                Message.formatMessage(
                    version,
                    nonce,
                    origin,
                    sender,
                    destination,
                    recipient,
                    body
                )
            ) ==
            keccak256(
                Message.formatMessageMemory(
                    version,
                    nonce,
                    origin,
                    sender,
                    destination,
                    recipient,
                    memoryBody
                )
            );
    }
}

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
///      Tracks nonces and reverts on reuse, matching real Permit2 behavior.
contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    // owner => token => spender => allowance
    mapping(address => mapping(address => mapping(address => PackedAllowance)))
        public allowances;

    // owner => token => spender => nonce => used
    mapping(address => mapping(address => mapping(address => mapping(uint48 => bool))))
        public usedNonces;

    error InvalidNonce();

    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160, uint48, uint48) {
        PackedAllowance storage a = allowances[owner][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }

    function permit(
        address owner,
        IAllowanceTransfer.PermitSingle calldata permitSingle,
        bytes calldata
    ) external {
        if (
            usedNonces[owner][permitSingle.details.token][permitSingle.spender][
                permitSingle.details.nonce
            ]
        ) revert InvalidNonce();
        usedNonces[owner][permitSingle.details.token][permitSingle.spender][
            permitSingle.details.nonce
        ] = true;
        allowances[owner][permitSingle.details.token][
            permitSingle.spender
        ] = PackedAllowance({
            amount: permitSingle.details.amount,
            expiration: permitSingle.details.expiration,
            nonce: permitSingle.details.nonce + 1
        });
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        PackedAllowance storage a = allowances[from][token][msg.sender];
        if (a.amount != type(uint160).max) {
            require(a.amount >= amount, "insufficient allowance");
            a.amount -= amount;
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

    function _deployQuotedCallsFeeRouter()
        internal
        returns (
            InterchainAccountRouter icaRouter,
            QuotedCallsERC20FeeHook feeHook
        )
    {
        feeHook = new QuotedCallsERC20FeeHook(primaryToken);
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(feeHook),
            address(this),
            0,
            icaUrls
        );
    }

    function _singleRemoteCall(
        bytes memory data
    ) internal pure returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: data
        });
    }

    function _quoteSingleCommand(
        bytes1 command,
        bytes memory input
    ) internal returns (uint256) {
        bytes1[] memory cmds = new bytes1[](1);
        bytes[] memory ins = new bytes[](1);
        cmds[0] = command;
        ins[0] = input;
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);
        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);
        assertEq(results[0].length, 1, "ICA should return one quote");
        assertEq(results[0][0].token, address(primaryToken));
        return results[0][0].amount;
    }

    function _quoteCallRemoteWithOverrides(
        InterchainAccountRouter icaRouter,
        bytes32 targetRouter,
        bytes32 ism,
        CallLib.Call[] memory calls,
        bytes memory hookMetadata,
        bytes32 salt
    ) internal returns (uint256) {
        (bytes1 command, bytes memory input) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            ism,
            calls,
            hookMetadata,
            salt,
            0,
            address(primaryToken),
            0
        );
        return _quoteSingleCommand(command, input);
    }

    function _quoteCallRemoteCommitReveal(
        InterchainAccountRouter icaRouter,
        QuotedCallsERC20FeeHook feeHook,
        bytes32 targetRouter,
        bytes32 ism,
        bytes memory hookMetadata,
        bytes32 salt,
        bytes32 commitment
    ) internal returns (uint256) {
        (bytes1 command, bytes memory input) = _cmdCallRemoteCommitReveal(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            ism,
            hookMetadata,
            address(feeHook),
            salt,
            commitment,
            0,
            address(primaryToken),
            0
        );
        return _quoteSingleCommand(command, input);
    }

    function _executeExactErc20IcaCommand(
        bytes1 icaCommand,
        bytes memory icaInput,
        uint256 fee
    ) internal {
        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdTransferFrom(address(primaryToken), fee);
        cmds[1] = icaCommand;
        ins[1] = icaInput;
        (cmds[2], ins[2]) = _cmdSweep(address(primaryToken));
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        primaryToken.approve(address(quotedCalls), fee);
        quotedCalls.execute(commands, inputs);
    }

    // ============ Tests: ERC20 transferFrom path ============

    function testFuzz_icaMemoryEncoding_matchesCalldata(
        address owner,
        bytes32 ism,
        bytes32 salt,
        address target,
        uint256 value,
        bytes calldata data
    ) public {
        vm.assume(data.length <= 512);
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call({
            to: target.addressToBytes32(),
            value: value,
            data: data
        });
        MessageEncodingHarness harness = new MessageEncodingHarness();
        assertTrue(harness.icaEncodingsMatch(owner, ism, calls, salt));
    }

    function testFuzz_messageMemoryEncoding_matchesCalldata(
        uint32 nonce,
        bytes32 sender,
        bytes calldata body
    ) public {
        vm.assume(body.length <= 512);
        MessageEncodingHarness harness = new MessageEncodingHarness();
        assertTrue(
            harness.messageEncodingsMatch(
                3,
                nonce,
                ORIGIN,
                sender,
                DESTINATION,
                BOB.addressToBytes32(),
                body
            )
        );
    }

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
        (uint160 amt, , ) = permit2.allowance(
            ALICE,
            address(primaryToken),
            address(quotedCalls)
        );
        assertEq(amt, 0);
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
        (uint160 amt2, , ) = permit2.allowance(
            ALICE,
            address(primaryToken),
            address(quotedCalls)
        );
        assertEq(amt2, 0);
    }

    // ============ Tests: Permit2 front-running ============

    /// @dev An attacker front-runs the user's tx by submitting the same permit
    ///      signature first. The permit nonce is consumed, so QuotedCalls'
    ///      PERMIT2_PERMIT would revert without the try/catch. The allowance was
    ///      already set by the front-runner's submission, so execute succeeds.
    function test_permit2Permit_frontrunned_succeeds() public {
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

        // Front-runner submits the same permit before ALICE's tx
        permit2.permit(ALICE, permitSingle, "");

        // Verify allowance was already set by the front-runner
        (uint160 frontrunAmt, , ) = permit2.allowance(
            ALICE,
            address(primaryToken),
            address(quotedCalls)
        );
        assertEq(frontrunAmt, uint160(totalTokens));

        // Directly calling permit again would revert (nonce consumed)
        vm.expectRevert(MockPermit2.InvalidNonce.selector);
        permit2.permit(ALICE, permitSingle, "");

        // But ALICE's execute should succeed — try/catch handles the revert
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

        vm.prank(ALICE);
        quotedCalls.execute(commands, inputs);

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    /// @dev Without try/catch, a front-run permit would cause the entire
    ///      execute to revert. This test verifies the nonce-reuse revert
    ///      behavior of MockPermit2 is correct (baseline for the above test).
    function test_permit2Permit_nonce_reuse_reverts() public {
        IAllowanceTransfer.PermitSingle memory permitSingle = IAllowanceTransfer
            .PermitSingle({
                details: IAllowanceTransfer.PermitDetails({
                    token: address(primaryToken),
                    amount: uint160(1e18),
                    expiration: uint48(block.timestamp + 3600),
                    nonce: 0
                }),
                spender: address(quotedCalls),
                sigDeadline: block.timestamp + 3600
            });

        // First call succeeds
        permit2.permit(ALICE, permitSingle, "");

        // Second call with same nonce reverts
        vm.expectRevert(MockPermit2.InvalidNonce.selector);
        permit2.permit(ALICE, permitSingle, "");
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
            address(igp),
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

    function test_quoteExecute_icaCommands_supportLegacyRouterQuoteSurface()
        public
    {
        QuotedCallsERC20FeeHook feeHook = new QuotedCallsERC20FeeHook(
            primaryToken
        );
        LegacyIcaRouterQuoteSurface legacyRouter = new LegacyIcaRouterQuoteSurface(
                localMailbox,
                feeHook,
                20_000
            );
        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT,
            address(quotedCalls),
            address(primaryToken)
        );
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes32 ism = bytes32(uint256(0x1234));
        bytes32 salt = bytes32(uint256(0x5678));

        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdCallRemoteWithOverrides(
            address(legacyRouter),
            DESTINATION,
            targetRouter,
            ism,
            _singleRemoteCall(hex"123456"),
            hookMetadata,
            salt,
            0,
            address(primaryToken),
            0
        );
        (cmds[1], ins[1]) = _cmdCallRemoteCommitReveal(
            address(legacyRouter),
            DESTINATION,
            targetRouter,
            ism,
            hookMetadata,
            address(feeHook),
            salt,
            keccak256("commitment"),
            0,
            address(primaryToken),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);

        // The legacy quote methods return sentinel values. Exact quotes must
        // instead be constructed through getters available on old routers.
        assertGt(results[0][0].amount, 2);
        assertGt(results[1][0].amount, 2);
        assertEq(results[0][0].token, address(primaryToken));
        assertEq(results[1][0].token, address(primaryToken));
    }

    function test_quoteExecuteThenExecute_icaCommands_supportLegacyRouterSurface()
        public
    {
        LegacyIcaRouterQuoteSurface legacyRouter = new LegacyIcaRouterQuoteSurface(
                localMailbox,
                noopHook,
                20_000
            );
        bytes memory hookMetadata = StandardHookMetadata.format(
            0,
            GAS_LIMIT,
            address(quotedCalls)
        );
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes32 salt = bytes32(uint256(0x5678));
        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdCallRemoteWithOverrides(
            address(legacyRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            _singleRemoteCall(hex"123456"),
            hookMetadata,
            salt,
            0,
            address(0),
            0
        );
        (cmds[1], ins[1]) = _cmdCallRemoteCommitReveal(
            address(legacyRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            hookMetadata,
            address(noopHook),
            salt,
            keccak256("commitment"),
            0,
            address(0),
            0
        );
        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);
        uint32 nonceBefore = localMailbox.nonce();

        Quote[][] memory results = quotedCalls.quoteExecute(commands, inputs);
        assertEq(results[0][0].amount, 0);
        assertEq(results[1][0].amount, 0);
        quotedCalls.execute(commands, inputs);

        assertEq(localMailbox.nonce(), nonceBefore + 3);
    }

    function test_quoteExecute_callRemoteWithOverrides_erc20ExactInputs()
        public
    {
        (
            InterchainAccountRouter icaRouter,
            QuotedCallsERC20FeeHook feeHook
        ) = _deployQuotedCallsFeeRouter();
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT,
            address(quotedCalls),
            address(primaryToken)
        );
        CallLib.Call[] memory remoteCalls = _singleRemoteCall(hex"123456");

        (bytes1 command, bytes memory input) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            remoteCalls,
            hookMetadata,
            bytes32(uint256(0x5678)),
            0,
            address(primaryToken),
            0
        );
        uint256 fee = _quoteSingleCommand(command, input);
        (, input) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            remoteCalls,
            hookMetadata,
            bytes32(uint256(0x5678)),
            0,
            address(primaryToken),
            fee
        );

        uint256 callerBalanceBefore = primaryToken.balanceOf(address(this));
        assertEq(icaRouter.routers(DESTINATION), bytes32(0));
        _executeExactErc20IcaCommand(command, input, fee);

        assertEq(
            primaryToken.balanceOf(address(this)),
            callerBalanceBefore - fee
        );
        assertEq(primaryToken.balanceOf(address(feeHook)), fee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        assertEq(primaryToken.balanceOf(address(icaRouter)), 0);
        assertEq(feeHook.dispatchCount(), 1);
        assertEq(feeHook.totalFees(), fee);
        assertEq(feeHook.lastRecipient(), targetRouter);
    }

    function test_quoteExecute_callRemoteCommitReveal_erc20ExactInputs()
        public
    {
        (
            InterchainAccountRouter icaRouter,
            QuotedCallsERC20FeeHook feeHook
        ) = _deployQuotedCallsFeeRouter();
        // Ensure quote and execution both honor the command's custom hook,
        // rather than silently using the router's configured hook.
        icaRouter.setHook(address(noopHook));
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT,
            address(quotedCalls),
            address(primaryToken)
        );

        (bytes1 command, bytes memory input) = _cmdCallRemoteCommitReveal(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            hookMetadata,
            address(feeHook),
            bytes32(uint256(0x5678)),
            keccak256("commitment"),
            0,
            address(primaryToken),
            0
        );
        uint256 fee = _quoteSingleCommand(command, input);
        (, input) = _cmdCallRemoteCommitReveal(
            address(icaRouter),
            DESTINATION,
            targetRouter,
            bytes32(uint256(0x1234)),
            hookMetadata,
            address(feeHook),
            bytes32(uint256(0x5678)),
            keccak256("commitment"),
            0,
            address(primaryToken),
            fee
        );

        uint256 callerBalanceBefore = primaryToken.balanceOf(address(this));
        assertEq(icaRouter.routers(DESTINATION), bytes32(0));
        _executeExactErc20IcaCommand(command, input, fee);

        assertEq(
            primaryToken.balanceOf(address(this)),
            callerBalanceBefore - fee
        );
        assertEq(primaryToken.balanceOf(address(feeHook)), fee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        assertEq(primaryToken.balanceOf(address(icaRouter)), 0);
        assertEq(feeHook.dispatchCount(), 2);
        assertEq(feeHook.totalFees(), fee);
        assertEq(feeHook.lastRecipient(), targetRouter);
    }

    function test_quoteExecute_callRemoteWithOverrides_bindsExecutionInputs()
        public
    {
        (InterchainAccountRouter icaRouter, ) = _deployQuotedCallsFeeRouter();
        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT,
            address(quotedCalls),
            address(primaryToken)
        );
        CallLib.Call[] memory remoteCalls = _singleRemoteCall(hex"123456");
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes32 ism = bytes32(uint256(0x1234));
        bytes32 salt = bytes32(uint256(0x5678));
        uint256 baseQuote = _quoteCallRemoteWithOverrides(
            icaRouter,
            targetRouter,
            ism,
            remoteCalls,
            hookMetadata,
            salt
        );

        assertNotEq(
            _quoteCallRemoteWithOverrides(
                icaRouter,
                bytes32(uint256(0xcafe)),
                ism,
                remoteCalls,
                hookMetadata,
                salt
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteWithOverrides(
                icaRouter,
                targetRouter,
                bytes32(uint256(0x9999)),
                remoteCalls,
                hookMetadata,
                salt
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteWithOverrides(
                icaRouter,
                targetRouter,
                ism,
                _singleRemoteCall(hex"abcdef"),
                hookMetadata,
                salt
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteWithOverrides(
                icaRouter,
                targetRouter,
                ism,
                remoteCalls,
                StandardHookMetadata.formatWithFeeToken(
                    0,
                    GAS_LIMIT + 1,
                    address(quotedCalls),
                    address(primaryToken)
                ),
                salt
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteWithOverrides(
                icaRouter,
                targetRouter,
                ism,
                remoteCalls,
                hookMetadata,
                bytes32(uint256(0x7777))
            ),
            baseQuote
        );

        vm.startPrank(ALICE);
        uint256 otherOwnerQuote = _quoteCallRemoteWithOverrides(
            icaRouter,
            targetRouter,
            ism,
            remoteCalls,
            hookMetadata,
            salt
        );
        vm.stopPrank();
        assertNotEq(otherOwnerQuote, baseQuote);
    }

    function test_quoteExecute_callRemoteCommitReveal_bindsExecutionInputs()
        public
    {
        (
            InterchainAccountRouter icaRouter,
            QuotedCallsERC20FeeHook feeHook
        ) = _deployQuotedCallsFeeRouter();
        icaRouter.setHook(address(noopHook));
        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT,
            address(quotedCalls),
            address(primaryToken)
        );
        bytes32 targetRouter = bytes32(uint256(0xbeef));
        bytes32 ism = bytes32(uint256(0x1234));
        bytes32 salt = bytes32(uint256(0x5678));
        bytes32 commitment = keccak256("commitment");
        uint256 baseQuote = _quoteCallRemoteCommitReveal(
            icaRouter,
            feeHook,
            targetRouter,
            ism,
            hookMetadata,
            salt,
            commitment
        );

        assertNotEq(
            _quoteCallRemoteCommitReveal(
                icaRouter,
                feeHook,
                bytes32(uint256(0xcafe)),
                ism,
                hookMetadata,
                salt,
                commitment
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteCommitReveal(
                icaRouter,
                feeHook,
                targetRouter,
                bytes32(uint256(0x9999)),
                hookMetadata,
                salt,
                commitment
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteCommitReveal(
                icaRouter,
                feeHook,
                targetRouter,
                ism,
                StandardHookMetadata.formatWithFeeToken(
                    0,
                    GAS_LIMIT + 1,
                    address(quotedCalls),
                    address(primaryToken)
                ),
                salt,
                commitment
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteCommitReveal(
                icaRouter,
                feeHook,
                targetRouter,
                ism,
                hookMetadata,
                bytes32(uint256(0x7777)),
                commitment
            ),
            baseQuote
        );
        assertNotEq(
            _quoteCallRemoteCommitReveal(
                icaRouter,
                feeHook,
                targetRouter,
                ism,
                hookMetadata,
                salt,
                keccak256("other commitment")
            ),
            baseQuote
        );

        vm.startPrank(ALICE);
        uint256 otherOwnerQuote = _quoteCallRemoteCommitReveal(
            icaRouter,
            feeHook,
            targetRouter,
            ism,
            StandardHookMetadata.formatWithFeeToken(
                0,
                GAS_LIMIT,
                address(quotedCalls),
                address(primaryToken)
            ),
            salt,
            commitment
        );
        vm.stopPrank();
        assertNotEq(otherOwnerQuote, baseQuote);
    }

    function test_execute_callRemoteWithOverrides_erc20UnderfundRevertsAtomically()
        public
    {
        (
            InterchainAccountRouter icaRouter,
            QuotedCallsERC20FeeHook feeHook
        ) = _deployQuotedCallsFeeRouter();
        uint256 callerBalanceBefore = primaryToken.balanceOf(address(this));
        uint32 nonceBefore = localMailbox.nonce();
        {
            bytes1[] memory cmds = new bytes1[](2);
            bytes[] memory ins = new bytes[](2);
            bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
                0,
                GAS_LIMIT,
                address(quotedCalls),
                address(primaryToken)
            );
            CallLib.Call[] memory remoteCalls = _singleRemoteCall(hex"123456");
            (bytes1 command, bytes memory input) = _cmdCallRemoteWithOverrides(
                address(icaRouter),
                DESTINATION,
                bytes32(uint256(0xbeef)),
                bytes32(uint256(0x1234)),
                remoteCalls,
                hookMetadata,
                bytes32(uint256(0x5678)),
                0,
                address(primaryToken),
                0
            );
            uint256 fee = _quoteSingleCommand(command, input);
            (, input) = _cmdCallRemoteWithOverrides(
                address(icaRouter),
                DESTINATION,
                bytes32(uint256(0xbeef)),
                bytes32(uint256(0x1234)),
                remoteCalls,
                hookMetadata,
                bytes32(uint256(0x5678)),
                0,
                address(primaryToken),
                fee
            );
            (cmds[0], ins[0]) = _cmdTransferFrom(
                address(primaryToken),
                fee - 1
            );
            cmds[1] = command;
            ins[1] = input;
            (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);
            primaryToken.approve(address(quotedCalls), fee - 1);

            vm.expectRevert("ERC20: transfer amount exceeds balance");
            quotedCalls.execute(commands, inputs);
        }

        assertEq(primaryToken.balanceOf(address(this)), callerBalanceBefore);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        assertEq(primaryToken.balanceOf(address(icaRouter)), 0);
        assertEq(primaryToken.balanceOf(address(feeHook)), 0);
        assertEq(feeHook.dispatchCount(), 0);
        assertEq(localMailbox.nonce(), nonceBefore);
        assertEq(
            primaryToken.allowance(address(quotedCalls), address(icaRouter)),
            0
        );
        assertEq(
            primaryToken.allowance(address(icaRouter), address(feeHook)),
            0
        );
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
