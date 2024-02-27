#!/usr/bin/env bash

# NOTE: This script is intended to be run from the root of the repo

echo -e "\nYou must have 'anvil' from Foundry installed to proceed."
echo -e '\nTo install, run the following command:'
echo -e '\tcurl -L https://foundry.paradigm.xyz | bash && foundryup && anvil\n'

read -p 'Press enter to continue running anvil...'

# Used by Anvil as export
export ANVIL_IP_ADDR='127.0.0.1'
# Passed to CLI option
export ANVIL_PORT=8545

echo -e "\nSpinning up anvil node at http://$ANVIL_IP_ADDR:$ANVIL_PORT..."

anvil -p $ANVIL_PORT
