// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {GnosisISM} from "../../contracts/isms/native/GnosisISM.sol";
import {GnosisMessageHook} from "../../contracts/hooks/GnosisMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {IHomeAMB, IForeignAMB} from "../../contracts/interfaces/hooks/vendor/IAMB.sol";

contract GnosisISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal gnosisFork;

    address internal constant FOREIGN_AMB_ADDRESS =
        0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e;
    address internal constant HOME_AMB_ADDRESS =
        0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59;

    uint8 internal constant VERSION = 0;

    IForeignAMB internal foreignAMB;
    GnosisISM internal gnosisISM;
    GnosisMessageHook internal gnosisHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    // data type required to pass AMB messages between mainnet to gnosis
    uint256 internal constant SEND_TO_ORACLE_DRIVEN_LANE = 0x00;

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant GNOSIS_DOMAIN = 100;

    event GnosisMessagePublished(
        address indexed sender,
        bytes32 indexed messageId
    );

    event UserRequestForAffirmation(
        bytes32 indexed messageId,
        bytes encodedData
    );

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        gnosisFork = vm.createFork(vm.rpcUrl("gnosis"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployGnosisHook() public {
        vm.selectFork(mainnetFork);

        foreignAMB = IForeignAMB(FOREIGN_AMB_ADDRESS);
        gnosisHook = new GnosisMessageHook(
            GNOSIS_DOMAIN,
            address(foreignAMB),
            address(gnosisISM)
        );

        vm.makePersistent(address(gnosisHook));
    }

    function deployGnosisISM() public {
        vm.selectFork(gnosisFork);

        gnosisISM = new GnosisISM(HOME_AMB_ADDRESS);

        vm.makePersistent(address(gnosisISM));
    }

    function deployAll() public {
        deployGnosisISM();
        deployGnosisHook();

        vm.selectFork(gnosisFork);
        gnosisISM.setGnosisHook(address(gnosisHook));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);

        vm.expectEmit(false, false, false, false, FOREIGN_AMB_ADDRESS);
        emit UserRequestForAffirmation(messageId, encodedMessage);

        vm.expectEmit(true, true, true, true, address(gnosisHook));
        emit GnosisMessagePublished(address(this), messageId);

        gnosisHook.postDispatch(GNOSIS_DOMAIN, messageId);
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("GnosisHook: invalid destination domain");
        gnosisHook.postDispatch(101, messageId);
    }

    function testDispatch_pendingMessages() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        // messageId set to non-zero value, meaning other messages are being processed
        vm.store(
            FOREIGN_AMB_ADDRESS,
            Message.id(abi.encodePacked("messageId")),
            bytes32(uint256(69420))
        );

        vm.expectRevert();
        gnosisHook.postDispatch(GNOSIS_DOMAIN, messageId);
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(gnosisFork);

        bytes32 _messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            GnosisISM.receiveFromHook,
            (address(this), _messageId)
        );

        IHomeAMB homeAMB = IHomeAMB(HOME_AMB_ADDRESS);

        uint256[2] memory chainIds = [uint256(1), uint256(100)];

        bytes memory AMBmessage = abi.encodePacked(
            bytes32(0),
            address(this),
            address(gnosisISM),
            uint32(26000),
            uint8(SEND_TO_ORACLE_DRIVEN_LANE),
            chainIds,
            encodedHookData
        );

        vm.prank();
        // TODO: fix this - check Validator and encoding
        homeAMB.executeAffirmation(AMBmessage);

        // vm.expectEmit(true, true, false, false, address(gnosisISM));
        // emit ReceivedMessage(address(this), _messageId);

        // assertEq(gnosisISM.receivedEmitters(_messageId, address(this)), true);

        vm.stopPrank();
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage(uint32 _msgCount, address _receipient)
        internal
        view
        returns (bytes memory encodedMessage)
    {
        encodedMessage = abi.encodePacked(
            VERSION,
            _msgCount,
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            GNOSIS_DOMAIN,
            TypeCasts.addressToBytes32(_receipient),
            testMessage
        );
    }
}
