FUNCTION=$1
CONTRACT_ADDRESS="0x78bbaf217f3bd5891fddca17af38951450cde1e9c73d2688e479422f12c86b41"
ADMIN_ADDRESS="0x1764fd45317bbddc6379f22c6c72b52a138bf0e2db76297e81146cacf7bc42c5"
TRIGGER_ADDRESS="0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568"

MAILBOX_ADDRESS="0x625e5a94c475896003c0f3a58377d5e349eabdbda61626d8a86d74d3ef341b0a"
APTOSDEVNET_DOMAIN=14477
APTOSTESTNET_DOMAIN=14402
BSCTESTNET_DOMAIN=97

VALIDATOR_ANNOUNCE_ADDRESS="0x61ad49767d3dd5d5e6e41563c3ca3e8600c52c350ca66014ee7f6874f28f5ddb"
ISM_ADDRESS="0x067ce50cd4f7248a654a964906e30f2eb9819bafdda696c3251ea31709858ef2"

VALIDATOR_ETH_SIGNER="0x598264ff31f198f6071226b2b7e9ce360163accd"

EXAMPLES_ADDRESS="0xec39c0c84a28e95abce3b525210a305605f225af74d4c1f5738569a64cbaf05c"
HELLO_RECIPIENT_ADDRESS="0x4f7E25AF605ad0AF84c333073f39f16346088819"

function init_msgbox() {
  cd mailbox && aptos move run --function-id $MAILBOX_ADDRESS::mailbox::initialize --args u32:$APTOSTESTNET_DOMAIN
}

function send_hello() {
  # 48656c6c6f20576f726c6421
  # 'u8:[0x48,0x65,0x6c,0x6c,0x6f,0x20,0x57,0x6f,0x72,0x6c,0x64,0x21]'
  cd examples && aptos move run --function-id $EXAMPLES_ADDRESS::hello_world::send_message --args u32:$BSCTESTNET_DOMAIN address:$HELLO_RECIPIENT_ADDRESS string:"Hello World!"
}

function init_validator() {
  cd validator-announce && aptos move run --function-id $VALIDATOR_ANNOUNCE_ADDRESS::validator_announce::initialize --args address:$MAILBOX_ADDRESS u32:$APTOSTESTNET_DOMAIN
}

function ism_set_validators() {
  cd isms && aptos move run --function-id $ISM_ADDRESS::multisig_ism::set_validators_and_threshold --args 'address:["0x598264ff31f198f6071226b2b7e9ce360163accd"]' u64:1 u32:97
}
#`address:0x1 bool:true u8:0 u256:1234 "bool:[true, false]" 'address:[["0xace", "0xbee"], []]'`

if [[ $FUNCTION == "" ]]; then
    echo "input function name"
else
    $FUNCTION
fi
