#!/bin/bash

# Install expect if not already installed
if ! command -v expect &> /dev/null
then
    echo "expect is not installed. Installing..."
    sudo apt-get update
    sudo apt-get install -y expect
fi

# Run the interactive command with expect
expect <<EOF
set timeout -1

spawn yarn hyperlane core deploy

expect "Please enter private key or use the HYP_KEY environment variable."
send "0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e\r"

expect "Select network type"
send "\033\[B"
send "\r"

expect "Select chain to connect:"
send "zksynclocal\r"

expect "Do you want to use an API key to verify on this (zksynclocal) chain's block explorer"
send "N\r"

expect "Is this deployment plan correct?"
send "y\r"

expect eof
EOF

echo "Hyperlane Core deployment process completed."
EOF