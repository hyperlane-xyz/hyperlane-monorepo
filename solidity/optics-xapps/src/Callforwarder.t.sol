pragma abicoder v2;

import "@celo-org/optics-sol/contracts/test/FoundryTest.t.sol";
import {TypeCasts} from "@celo-org/optics-sol/contracts/XAppConnectionManager.sol";
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";

import "../contracts/callforwarder/CallforwarderRouter.sol";
import "../contracts/callforwarder/CallforwarderMessage.sol";
import "../contracts/callforwarder/CallforwarderProxy.sol";

contract TransferRecorder {
    address public recipient;
    uint256 public value;

    function transfer(address _recipient, uint256 _value) public {
        recipient = _recipient;
        value = _value;
    }
}

contract Poop {
  function logMe(bytes29 _msg) public {
  
    }
    function logBytes(bytes memory _msg) public {

    }

    function logAddress(address d) public {

    }

    function logUint(uint a) public {}

    function logBytes32(bytes32 a) public {}
}

contract CallForwarderTest is MockOpticsDeployment, DSTest {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using CallforwarderMessage for bytes29;

    CallforwarderRouter senderRouter;
    CallforwarderRouter recipientRouter;
    CallForwarderProxy recipientProxy;

    function setUp() public {
        setupMockDeployment();

        senderRouter = new CallforwarderRouter(
            address(senderXAppConnectionManager)
        );
        recipientRouter = new CallforwarderRouter(
            address(recipientXAppConnectionMnaager)
        );

        senderRouter.enrollRemoteRouter(
            recipientDomain,
            TypeCasts.addressToBytes32(address(recipientRouter))
        );
        recipientRouter.enrollRemoteRouter(
            senderDomain,
            TypeCasts.addressToBytes32(address(senderRouter))
        );
    }

    function testMult() public {
      uint8 _bytes = 32;
      uint8 bitLength = _bytes * 8;
    }

    function testMessage() public {
      Poop poop = new Poop();
      bytes memory transferData = abi.encodeWithSignature(
                "transfer(address,uint256)",
                address(1),
                1
            );
        CallforwarderMessage.Call[]
            memory _calls = new CallforwarderMessage.Call[](1);

        _calls[0] = CallforwarderMessage.Call({
            to: TypeCasts.addressToBytes32(address(1)),
            data: transferData
        });
        bytes memory _msg = CallforwarderMessage.formatCalls(
            address(1),
            _calls
        );
        poop.logBytes(_msg);

        bytes29 _msgC = _msg.ref(0);
        // poop.logMe(_msgC);
        // poop.logUint(_msgC.indexUint(0, 1));
        // poop.logUint(uint(_msgC.len()));
        
        poop.logBytes32(_msgC.index(0, 32));
        require(_msgC.isValidCall(), "!valid");
        bytes29 _msgCC = _msgC.tryAsCall();
        require(_msgCC.isType(uint40(CallforwarderMessage.Types.Call)), "!type");

        CallforwarderMessage.Call[] memory _callsG = _msgCC.getCalls();
        require(TypeCasts.bytes32ToAddress(_callsG[0].to) == address(1), "!address");
        require(keccak256(_callsG[0].data) == keccak256(transferData), "!data");
        
        require(TypeCasts.bytes32ToAddress(_msgCC.from()) == address(1), "not1");
    }

    function testRecorder() public {
      TransferRecorder recorder = new TransferRecorder();
      bytes memory callData = abi.encodeWithSignature(
                "transfer(address,uint256)",
                address(1),
                1
            );
      require(recorder.recipient() == address(0), "!recipient0");
      
      address(recorder).call(callData);
      
      require(recorder.recipient() == address(1), "!recipient");

      require(recorder.value() == 1, "!value");
    }

    function testProxy() public {
      TransferRecorder recorder = new TransferRecorder();
      recipientProxy = new CallForwarderProxy(
          address(this),
          address(recorder),
          address(this),
          senderDomain
      );

      bytes memory callData = abi.encodeWithSignature(
                "transfer(address,uint256)",
                address(1),
                1);
      
      require(recorder.recipient() == address(0), "!recipient0");

      recipientProxy.callFromRouter(address(this), senderDomain, callData);
      
      require(recorder.recipient() == address(1), "!recipient1");
    }

    function testFoo() public {
        TransferRecorder recorder = new TransferRecorder();
        recipientProxy = new CallForwarderProxy(
            address(recipientRouter),
            address(recorder),
            address(this),
            senderDomain
        );

        CallforwarderMessage.Call[]
            memory _calls = new CallforwarderMessage.Call[](1);

        _calls[0] = CallforwarderMessage.Call({
            to: TypeCasts.addressToBytes32(address(recipientProxy)),
            data: abi.encodeWithSignature(
                "transfer(address,uint256)",
                address(1),
                1
            )
        });

        senderRouter.callRemote(recipientDomain, _calls);
        replica.flushMessages();
        require(recorder.recipient() == address(1), "!recipient");

        require(recorder.value() == 1, "!value");
    }
}
