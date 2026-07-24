// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {AbstractMessageIdAuthHook} from "../../contracts/hooks/libs/AbstractMessageIdAuthHook.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {Message} from "../../contracts/libs/Message.sol";

import {AxelarHook} from "../../contracts/hooks/AxelarHook.sol";
import {AxelarIsm} from "../../contracts/isms/hook/AxelarIsm.sol";
import {IAxelarGateway} from "../../contracts/interfaces/axelar/IAxelarGateway.sol";
import {IAxelarGasService} from "../../contracts/interfaces/axelar/IAxelarGasService.sol";
import {IAxelarExecutable} from "../../contracts/interfaces/axelar/IAxelarExecutable.sol";
import {AddressToString, StringToAddress} from "../../contracts/interfaces/axelar/AddressString.sol";
import {MockAxelarGateway, MockAxelarGasService} from "../../contracts/mock/MockAxelar.sol";

import {ExternalBridgeTest} from "./ExternalBridgeTest.sol";
import {MessageUtils} from "./IsmTestUtils.sol";

/**
 * @notice Test suite for {AxelarHook} + {AxelarIsm}.
 * @dev Extends {ExternalBridgeTest} to inherit the shared hook/ISM behavioural
 * suite, overriding the bridge-specific hooks for Axelar GMP semantics. Axelar
 * does not deliver native value to the destination, so value-bridging tests are
 * overridden to assert the unsupported-value behaviour. Axelar-specific branches
 * (gateway approval, source authorization, payload validation, gas payment,
 * string<>address conversion) are covered by dedicated tests below.
 */
contract AxelarIsmTest is ExternalBridgeTest {
    using TypeCasts for address;
    using MessageUtils for bytes;
    using AddressToString for address;

    string internal constant AXELAR_ORIGIN_CHAIN = "ethereum";
    string internal constant AXELAR_DESTINATION_CHAIN = "arbitrum";

    MockAxelarGateway internal gateway;
    MockAxelarGasService internal gasService;

    AxelarHook internal axelarHook;
    AxelarIsm internal axelarIsm;
    AddressStringHarness internal addrLib;

    function setUp() public override {
        // Axelar gas cannot be quoted on-chain; the hook returns a 0 quote and
        // the caller attaches native value, so the shared harness runs with GAS_QUOTE = 0.
        GAS_QUOTE = 0;

        gateway = new MockAxelarGateway();
        gasService = new MockAxelarGasService();
        addrLib = new AddressStringHarness();

        deployAll();
        super.setUp();
    }

    /* ============ setup ============ */

    function deployIsm() public {
        axelarIsm = new AxelarIsm(address(gateway), AXELAR_ORIGIN_CHAIN);
        ism = AbstractMessageIdAuthorizedIsm(address(axelarIsm));
    }

    function deployHook() public {
        originMailbox = new TestMailbox(ORIGIN_DOMAIN);
        axelarHook = new AxelarHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            address(gateway),
            address(gasService),
            AXELAR_DESTINATION_CHAIN
        );
        hook = AbstractMessageIdAuthHook(address(axelarHook));
    }

    function deployAll() public {
        deployIsm();
        deployHook();
        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
    }

    /* ============ ExternalBridgeTest hooks ============ */

    function _expectOriginExternalBridgeCall(
        bytes memory _encodedHookData
    ) internal override {
        vm.expectCall(
            address(gateway),
            abi.encodeCall(
                IAxelarGateway.callContract,
                (
                    AXELAR_DESTINATION_CHAIN,
                    AddressToString.toString(address(ism)),
                    _encodedHookData
                )
            )
        );
    }

    /// @dev Simulates the Axelar network delivering the GMP message to the ISM.
    /// Native value is never carried by Axelar GMP, so `_msgValue` is ignored.
    function _externalBridgeDestinationCall(
        bytes memory _encodedHookData,
        uint256
    ) internal override {
        (bytes32 commandId, string memory source) = _approveDelivery(
            _encodedHookData
        );
        axelarIsm.execute(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            source,
            _encodedHookData
        );
    }

    /// @dev Registers a gateway approval for a delivery from the authorized hook
    /// on the trusted origin chain, returning the (commandId, source) so callers
    /// can invoke `execute` as a separate statement. This lets `vm.expectRevert`
    /// scope to the `execute` call rather than the (successful) approval.
    function _approveDelivery(
        bytes memory hookData
    ) internal returns (bytes32 commandId, string memory source) {
        source = AddressToString.toString(address(hook));
        commandId = keccak256(hookData);
        gateway.approveContractCall(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            source,
            address(ism),
            keccak256(hookData)
        );
    }

    /// @dev Axelar verification is asynchronous (execute writes storage, then
    /// `verify` reads it); there is no synchronous metadata-bearing verify path.
    function _encodeExternalDestinationBridgeCall(
        address,
        address,
        uint256,
        bytes32
    ) internal pure override returns (bytes memory) {
        return new bytes(0);
    }

    /* ============ overrides: no synchronous external-bridge verify path ============ */

    function test_preVerifyMessage_externalBridgeCall() public override {}

    function test_verify_msgValue_externalBridgeCall() public override {}

    function test_verify_revertsWhen_invalidIsm() public override {}

    function test_verify_false_arbitraryCall() public override {}

    function test_verify_revertWhen_invalidMetadata() public override {
        // verify() never reverts on empty metadata; it simply reports unverified.
        assertFalse(ism.verify(new bytes(0), encodedMessage));
    }

    /* ============ overrides: Axelar carries no native value ============ */

    function test_verify_msgValue_asyncCall() public override {
        // A delivery encoding a non-zero msgValue cannot be verified because the
        // destination call carries zero native value.
        bytes memory encodedHookData = _encodeHookData(messageId, MSG_VALUE);
        (bytes32 commandId, string memory source) = _approveDelivery(
            encodedHookData
        );

        vm.expectRevert("AbstractMessageIdAuthorizedIsm: invalid msg.value");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, source, encodedHookData);

        assertFalse(ism.isVerified(encodedMessage));
        assertEq(address(testRecipient).balance, 0);
    }

    function test_verify_override_msgValue() public override {
        bytes memory encodedHookData = _encodeHookData(messageId, MSG_VALUE);
        (bytes32 commandId, string memory source) = _approveDelivery(
            encodedHookData
        );

        vm.expectRevert("AbstractMessageIdAuthorizedIsm: invalid msg.value");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, source, encodedHookData);

        assertFalse(ism.isVerified(encodedMessage));
    }

    function test_verify_valueAlreadyClaimed(uint256) public override {
        // Verification always records zero value; recipient never receives funds.
        _externalBridgeDestinationCall(_encodeHookData(messageId, 0), 0);

        bool verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
        assertEq(address(ism).balance, 0);
        assertEq(address(testRecipient).balance, 0);

        // A repeated verify remains true and is a no-op on balances.
        verified = ism.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
        assertEq(address(testRecipient).balance, 0);
    }

    /* ============ overrides: source authorization (Axelar-specific) ============ */

    function test_verify_revertsWhen_notAuthorizedHook() public override {
        string memory badSource = AddressToString.toString(address(this));
        bytes memory payload = _encodeHookData(messageId, 0);
        bytes32 commandId = keccak256(payload);
        gateway.approveContractCall(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            badSource,
            address(ism),
            keccak256(payload)
        );

        vm.expectRevert("AxelarIsm: untrusted source address");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, badSource, payload);

        assertFalse(ism.isVerified(encodedMessage));
    }

    function test_verify_revertsWhen_incorrectMessageId() public override {
        bytes32 incorrectMessageId = keccak256("incorrect message id");
        // The wrong id is verified, so the real message remains unverified.
        _externalBridgeDestinationCall(
            _encodeHookData(incorrectMessageId, 0),
            0
        );
        assertFalse(ism.isVerified(testMessage));
    }

    /* ============ Axelar: hook configuration & construction ============ */

    function test_hook_configuration() public view {
        assertEq(address(axelarHook.axelarGateway()), address(gateway));
        assertEq(address(axelarHook.axelarGasService()), address(gasService));
        assertEq(axelarHook.destinationChain(), AXELAR_DESTINATION_CHAIN);
        assertEq(axelarHook.destinationDomain(), DESTINATION_DOMAIN);
        assertEq(axelarHook.ism(), TypeCasts.addressToBytes32(address(ism)));
    }

    function test_hook_constructor_revertWhen_invalidGateway() public {
        vm.expectRevert("AxelarHook: invalid gateway");
        new AxelarHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            address(0xdead), // EOA, not a contract
            address(gasService),
            AXELAR_DESTINATION_CHAIN
        );
    }

    function test_hook_constructor_revertWhen_invalidGasService() public {
        vm.expectRevert("AxelarHook: invalid gas service");
        new AxelarHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            address(gateway),
            address(0xdead),
            AXELAR_DESTINATION_CHAIN
        );
    }

    function test_hook_constructor_revertWhen_emptyDestinationChain() public {
        vm.expectRevert("AxelarHook: invalid destination chain");
        new AxelarHook(
            address(originMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(ism)),
            address(gateway),
            address(gasService),
            ""
        );
    }

    /* ============ Axelar: hook value semantics & gas payment ============ */

    function test_quoteDispatch_revertWhen_msgValue() public {
        bytes memory metadata = StandardHookMetadata.overrideMsgValue(
            MSG_VALUE
        );
        vm.expectRevert("AxelarHook: msgValue not supported");
        hook.quoteDispatch(metadata, encodedMessage);
    }

    function test_postDispatch_revertWhen_msgValue() public {
        bytes memory metadata = StandardHookMetadata.overrideMsgValue(
            MSG_VALUE
        );
        originMailbox.updateLatestDispatchedId(messageId);

        vm.deal(address(this), MSG_VALUE);
        vm.expectRevert("AxelarHook: msgValue not supported");
        hook.postDispatch{value: MSG_VALUE}(metadata, encodedMessage);
    }

    function test_postDispatch_forwardsValueToGasService() public {
        uint256 payment = 0.01 ether;
        vm.deal(address(this), payment);

        bytes memory encodedHookData = _encodeHookData(messageId, 0);
        originMailbox.updateLatestDispatchedId(messageId);

        vm.expectCall(
            address(gasService),
            payment,
            abi.encodeCall(
                IAxelarGasService.payNativeGasForContractCall,
                (
                    address(hook),
                    AXELAR_DESTINATION_CHAIN,
                    AddressToString.toString(address(ism)),
                    encodedHookData,
                    address(this) // refund address from testMetadata
                )
            )
        );

        hook.postDispatch{value: payment}(testMetadata, encodedMessage);

        assertEq(address(gasService).balance, payment);
        assertEq(address(hook).balance, 0);
    }

    /// @dev Overrides the shared refund test: Axelar uses an over-pay model, so
    /// the entire attached value is forwarded to the Gas Service (refunded
    /// off-chain by Axelar) rather than refunded on-chain.
    function testFuzz_postDispatch_refundsExtraValue(
        uint256 value
    ) public override {
        value = bound(value, 0, MAX_MSG_VALUE);
        vm.deal(address(this), value);

        bytes memory encodedHookData = _encodeHookData(messageId, 0);
        originMailbox.updateLatestDispatchedId(messageId);
        _expectOriginExternalBridgeCall(encodedHookData);

        hook.postDispatch{value: value}(testMetadata, encodedMessage);

        assertEq(address(gasService).balance, value);
        assertEq(address(hook).balance, 0);
    }

    /* ============ Axelar: ISM construction ============ */

    function test_ism_configuration() public view {
        assertEq(address(axelarIsm.gateway()), address(gateway));
        assertEq(axelarIsm.originChain(), AXELAR_ORIGIN_CHAIN);
        assertEq(
            axelarIsm.originChainHash(),
            keccak256(bytes(AXELAR_ORIGIN_CHAIN))
        );
        assertEq(
            axelarIsm.authorizedHook(),
            TypeCasts.addressToBytes32(address(hook))
        );
        assertEq(uint256(axelarIsm.moduleType()), 6); // Types.NULL
    }

    function test_ism_constructor_revertWhen_zeroGateway() public {
        vm.expectRevert(IAxelarExecutable.InvalidAddress.selector);
        new AxelarIsm(address(0), AXELAR_ORIGIN_CHAIN);
    }

    function test_ism_constructor_revertWhen_emptyOriginChain() public {
        vm.expectRevert("AxelarIsm: invalid origin chain");
        new AxelarIsm(address(gateway), "");
    }

    /* ============ Axelar: execute() authorization branches ============ */

    function test_execute_revertWhen_notApprovedByGateway() public {
        bytes memory payload = _encodeHookData(messageId, 0);
        string memory source = AddressToString.toString(address(hook));

        vm.expectRevert(IAxelarExecutable.NotApprovedByGateway.selector);
        axelarIsm.execute(
            keccak256(payload),
            AXELAR_ORIGIN_CHAIN,
            source,
            payload
        );
    }

    function test_execute_revertWhen_untrustedSourceChain() public {
        bytes memory payload = _encodeHookData(messageId, 0);
        string memory source = AddressToString.toString(address(hook));
        bytes32 commandId = keccak256(payload);
        gateway.approveContractCall(
            commandId,
            "polygon",
            source,
            address(ism),
            keccak256(payload)
        );

        vm.expectRevert("AxelarIsm: untrusted source chain");
        axelarIsm.execute(commandId, "polygon", source, payload);
    }

    function test_execute_revertWhen_shortPayload() public {
        bytes memory payload = hex"00112233"; // 4 bytes but wrong selector
        string memory source = AddressToString.toString(address(hook));
        bytes32 commandId = keccak256(payload);
        gateway.approveContractCall(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            source,
            address(ism),
            keccak256(payload)
        );

        vm.expectRevert("AxelarIsm: invalid payload");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, source, payload);
    }

    function test_execute_revertWhen_payloadTooShort() public {
        bytes memory payload = hex"0011"; // < 4 bytes
        string memory source = AddressToString.toString(address(hook));
        bytes32 commandId = keccak256(payload);
        gateway.approveContractCall(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            source,
            address(ism),
            keccak256(payload)
        );

        vm.expectRevert("AxelarIsm: invalid payload");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, source, payload);
    }

    function test_execute_revertWhen_alreadyVerified() public {
        bytes memory payload = _encodeHookData(messageId, 0);
        _externalBridgeDestinationCall(payload, 0);
        assertTrue(ism.isVerified(encodedMessage));

        // Replaying the same message id is rejected by preVerifyMessage and the
        // revert bubbles up through execute.
        string memory source = AddressToString.toString(address(hook));
        bytes32 commandId = keccak256(abi.encode("second", payload));
        gateway.approveContractCall(
            commandId,
            AXELAR_ORIGIN_CHAIN,
            source,
            address(ism),
            keccak256(payload)
        );
        vm.expectRevert("AbstractMessageIdAuthorizedIsm: message already verified");
        axelarIsm.execute(commandId, AXELAR_ORIGIN_CHAIN, source, payload);
    }

    function test_preVerifyMessage_revertWhen_directCall() public {
        vm.expectRevert("AbstractMessageIdAuthorizedIsm: sender is not the hook");
        axelarIsm.preVerifyMessage(messageId, 0);
    }

    /* ============ Axelar: AddressString library ============ */

    function testFuzz_addressString_roundtrip(address a) public view {
        assertEq(addrLib.toAddress(addrLib.toString(a)), a);
    }

    function test_stringToAddress_revertWhen_wrongLength() public {
        vm.expectRevert(StringToAddress.InvalidAddressString.selector);
        addrLib.toAddress("0x1234");
    }

    function test_stringToAddress_revertWhen_missingPrefix() public {
        // 42 chars but not 0x-prefixed
        vm.expectRevert(StringToAddress.InvalidAddressString.selector);
        addrLib.toAddress("0X00000000000000000000000000000000000000ab");
    }

    function test_stringToAddress_revertWhen_invalidChar() public {
        // 42 chars, 0x-prefixed, but contains a non-hex character ('z' = 122)
        vm.expectRevert(StringToAddress.InvalidAddressString.selector);
        addrLib.toAddress("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    }

    function test_stringToAddress_acceptsUppercaseHex() public view {
        // Axelar peers may emit checksummed/uppercase hex; parsing must be
        // case-insensitive so source authorization is robust to casing.
        address expected = 0xabCDeF0123456789AbcdEf0123456789aBCDEF01;
        assertEq(
            addrLib.toAddress("0xABCDEF0123456789ABCDEF0123456789ABCDEF01"),
            expected
        );
    }
}

/**
 * @notice Exposes the internal AddressString libraries as external functions so
 * their success and revert branches can be asserted directly.
 */
contract AddressStringHarness {
    using StringToAddress for string;
    using AddressToString for address;

    function toAddress(string calldata s) external pure returns (address) {
        return s.toAddress();
    }

    function toString(address a) external pure returns (string memory) {
        return a.toString();
    }
}
