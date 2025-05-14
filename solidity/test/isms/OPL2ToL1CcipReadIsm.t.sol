import "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {MockOptimismPortal} from "../../contracts/mock/MockOptimism.sol";
import {OPL2ToL1CcipReadIsm} from "../../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {IOptimismPortal} from "../../contracts/interfaces/optimism/IOptimismPortal.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {LightTestRecipient} from "../../contracts/test/LightTestRecipient.sol";

import {console} from "forge-std/console.sol";

contract OPL2ToL1CcipReadIsmTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;

    address payable internal constant L2_BRIDGE_ADDRESS =
        payable(0x4200000000000000000000000000000000000010);

    uint256 internal constant scale = 1;

    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;

    address tokenBridgeOrigin;
    address tokenBridgeDestination;

    OPL2ToL1CcipReadIsm internal ism;

    string[] urls;
    IOptimismPortal portal;
    MockHyperlaneEnvironment internal environment;
    MockMailbox mailboxOrigin;
    MockMailbox mailboxDestination;

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function setUp() public {
        urls = new string[](1);
        urls[0] = "https://ccip-read-gateway.io";
        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);
        portal = new MockOptimismPortal();

        // We just need two contracts
        tokenBridgeOrigin = address(new LightTestRecipient());
        tokenBridgeDestination = address(new LightTestRecipient());

        ism = new OPL2ToL1CcipReadIsm(
            urls,
            address(portal),
            address(mailboxDestination)
        );

        mailboxDestination.setDefaultIsm(address(ism));
        mailboxDestination.addRemoteMailbox(origin, mailboxOrigin);
    }

    function test_verify_revertsWhen_mailboxTryToCallVerify() public {
        mailboxOrigin.dispatch(
            destination,
            address(ism).addressToBytes32(),
            bytes("")
        );

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        vm.expectRevert();
        environment.processNextPendingMessage();
    }

    function _getDummyVerifyMetadata(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal returns (bytes memory) {
        uint256 gameIndex = 0;
        IOptimismPortal.OutputRootProof memory outputRootProof;
        bytes[] memory proof;
        return abi.encode(_tx, gameIndex, outputRootProof, proof);
    }

    function _getDummyWithdrawalTx(
        uint256 nonce,
        uint256 amount,
        bytes memory data
    ) internal returns (IOptimismPortal.WithdrawalTransaction memory) {
        uint256 gasLimit = 200_000;

        return
            IOptimismPortal.WithdrawalTransaction(
                nonce,
                tokenBridgeOrigin,
                tokenBridgeDestination,
                amount,
                gasLimit,
                data
            );
    }

    function test_verify_proveWithdrawalSuccessfully() public {
        uint256 amount = 0.001 ether;

        IOptimismPortal.WithdrawalTransaction
            memory withdrawalTx = _getDummyWithdrawalTx(0, amount, bytes(""));

        mailboxOrigin.dispatch(
            destination,
            address(ism).addressToBytes32(),
            bytes("")
        );

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);
        bytes memory metadata = _getDummyVerifyMetadata(withdrawalTx);

        ism.verify(metadata, message);
    }

    function test_verify_finalizeWithdrawalSuccessfully() public {
        uint256 amount = 0.001 ether;
        IOptimismPortal.WithdrawalTransaction
            memory withdrawalTx = _getDummyWithdrawalTx(0, amount, bytes(""));

        mailboxOrigin.dispatch(
            destination,
            address(tokenBridgeDestination).addressToBytes32(),
            bytes("")
        );

        vm.deal(address(portal), amount);

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);
        bytes memory metadata = _getDummyVerifyMetadata(withdrawalTx);

        ism.verify(metadata, message);
    }

    function test_interchainSecurityModule_givenIsmIsCorrect() public {
        assertEq(address(ism.interchainSecurityModule()), address(ism));
    }

    function test_handle_emitReceivedMessageEvent() public {
        uint256 amount = 0.001 ether;
        IOptimismPortal.WithdrawalTransaction
            memory withdrawalTx = _getDummyWithdrawalTx(0, amount, bytes(""));

        mailboxOrigin.dispatch(
            destination,
            address(ism).addressToBytes32(),
            bytes("")
        );

        vm.deal(address(portal), amount);

        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);
        bytes memory metadata = _getDummyVerifyMetadata(withdrawalTx);

        vm.expectEmit(address(ism));
        emit OPL2ToL1CcipReadIsm.ReceivedMessage(
            origin,
            address(this).addressToBytes32(),
            0,
            bytes("")
        );
        ism.process(metadata, message);
    }
}
