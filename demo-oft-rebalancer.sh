#!/bin/bash

# =============================================================================
# Hyperlane OFT Rebalancer Demo Script
# =============================================================================
# 
# This script demonstrates the complete OFT rebalancer functionality including:
# - Balance checking on both chains
# - Manual rebalancing 
# - Automatic rebalancing with live monitoring
# - Creating imbalances to see auto-recovery
#
# Prerequisites:
# - Node.js v20.8.1+ via nvm
# - Private key with test ETH on Sepolia and Arbitrum Sepolia  
# - cast CLI tool for balance checking
#
# Usage: 
#   HYP_KEY=<your-private-key> ./demo-oft-rebalancer.sh
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'  
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SEPOLIA_RPC="https://sepolia.drpc.org"
ARBITRUM_RPC="https://arbitrum-sepolia.drpc.org"
SEPOLIA_ROUTER="0x7Ae1D97D2e253271F1f851177B20413c1a954BEf"
ARBITRUM_ROUTER="0xDcEC4233640D32652f35C35E90143dA37ea78beE"
CLI_DIR="typescript/cli"

echo -e "${BLUE}=== Hyperlane OFT Rebalancer Demo ===${NC}"
echo "This demo will show you the OFT rebalancer in action!"
echo ""

# Check prerequisites
if [ -z "$HYP_KEY" ]; then
    echo -e "${RED}ERROR: HYP_KEY environment variable not set${NC}"
    echo "Usage: HYP_KEY=<your-private-key> ./demo-oft-rebalancer.sh"
    exit 1
fi

if ! command -v cast &> /dev/null; then
    echo -e "${YELLOW}WARNING: 'cast' command not found. Balance checking will be skipped.${NC}"
    echo "Install foundry for balance checking: curl -L https://foundry.paradigm.xyz | bash"
    echo ""
fi

# Setup Node.js environment
echo -e "${BLUE}Step 1: Setting up Node.js environment${NC}"
if command -v nvm &> /dev/null; then
    source ~/.nvm/nvm.sh
    nvm use v20.8.1 || nvm install v20.8.1
else
    echo -e "${YELLOW}WARNING: nvm not found. Make sure you're using Node.js v20.8.1+${NC}"
fi
echo ""

cd "$CLI_DIR"

# Function to check balances
check_balances() {
    echo -e "${BLUE}=== Current Router Balances ===${NC}"
    
    if command -v cast &> /dev/null; then
        echo -n "Sepolia Router Balance: "
        SEPOLIA_BALANCE=$(cast call --rpc-url "$SEPOLIA_RPC" "$SEPOLIA_ROUTER" "balanceOf(address)" "$SEPOLIA_ROUTER" 2>/dev/null || echo "Error")
        if [ "$SEPOLIA_BALANCE" != "Error" ]; then
            # Convert from wei to ether (divide by 10^18)
            SEPOLIA_ETH=$(echo "scale=6; $SEPOLIA_BALANCE / 1000000000000000000" | bc 2>/dev/null || echo "N/A")
            echo -e "${GREEN}${SEPOLIA_ETH} OFT${NC}"
        else
            echo -e "${RED}Error fetching balance${NC}"
        fi
        
        echo -n "Arbitrum Router Balance: "
        ARB_BALANCE=$(cast call --rpc-url "$ARBITRUM_RPC" "$ARBITRUM_ROUTER" "balanceOf(address)" "$ARBITRUM_ROUTER" 2>/dev/null || echo "Error")
        if [ "$ARB_BALANCE" != "Error" ]; then
            ARB_ETH=$(echo "scale=6; $ARB_BALANCE / 1000000000000000000" | bc 2>/dev/null || echo "N/A")
            echo -e "${GREEN}${ARB_ETH} OFT${NC}"
        else
            echo -e "${RED}Error fetching balance${NC}"
        fi
    else
        echo -e "${YELLOW}Install 'cast' to see live balances${NC}"
    fi
    echo ""
}

# Check initial balances
check_balances

# Demo menu
while true; do
    echo -e "${BLUE}=== Demo Menu ===${NC}"
    echo "1. Check current balances"
    echo "2. Run manual rebalance (0.005 OFT from Sepolia to Arbitrum)"
    echo "3. Run automatic rebalancer (live monitoring - Ctrl+C to stop)"
    echo "4. Monitor only mode (no transactions, just balance checking)"
    echo "5. Create imbalance and watch auto-recovery"
    echo "6. Exit"
    echo ""
    read -p "Select an option (1-6): " choice

    case $choice in
        1)
            echo -e "${BLUE}Step: Checking balances${NC}"
            check_balances
            ;;
        
        2)
            echo -e "${BLUE}Step: Running manual rebalance${NC}"
            echo "This will transfer 0.005 OFT from Sepolia to Arbitrum..."
            echo ""
            
            HYP_KEY=$HYP_KEY npx tsx cli.ts warp rebalancer \
                --config ../../fixed-oft-manual.yaml \
                --warp ../../fixed-oft-warp.json \
                --registry ./local-registry \
                --manual \
                --origin sepolia \
                --destination arbitrumsepolia \
                --amount 0.005
            
            echo ""
            echo -e "${GREEN}Manual rebalance completed!${NC}"
            sleep 2
            check_balances
            ;;
        
        3)
            echo -e "${BLUE}Step: Starting automatic rebalancer${NC}"
            echo "This will continuously monitor and automatically rebalance when needed."
            echo -e "${YELLOW}Press Ctrl+C to stop the rebalancer${NC}"
            echo ""
            
            HYP_KEY=$HYP_KEY npx tsx cli.ts warp rebalancer \
                --config ../../fixed-oft-auto.yaml \
                --warp ../../fixed-oft-warp.json \
                --registry ./local-registry \
                --checkFrequency 10000
            ;;
        
        4)
            echo -e "${BLUE}Step: Monitor only mode${NC}"
            echo "This will show balance monitoring without executing transactions."
            echo -e "${YELLOW}Press Ctrl+C to stop monitoring${NC}"
            echo ""
            
            HYP_KEY=$HYP_KEY npx tsx cli.ts warp rebalancer \
                --config ../../fixed-oft-auto.yaml \
                --warp ../../fixed-oft-warp.json \
                --registry ./local-registry \
                --monitorOnly \
                --checkFrequency 10000
            ;;
        
        5)
            echo -e "${BLUE}Step: Create imbalance and watch auto-recovery${NC}"
            echo "This will:"
            echo "1. Create an imbalance by manual transfer"
            echo "2. Start automatic rebalancer to watch it recover"
            echo ""
            
            # Create imbalance
            echo -e "${YELLOW}Creating imbalance...${NC}"
            HYP_KEY=$HYP_KEY npx tsx cli.ts warp rebalancer \
                --config ../../fixed-oft-manual.yaml \
                --warp ../../fixed-oft-warp.json \
                --registry ./local-registry \
                --manual \
                --origin sepolia \
                --destination arbitrumsepolia \
                --amount 0.003
            
            sleep 3
            check_balances
            
            echo -e "${YELLOW}Now starting automatic rebalancer to recover...${NC}"
            echo -e "${YELLOW}Watch it detect and fix the imbalance! Press Ctrl+C when done.${NC}"
            echo ""
            
            HYP_KEY=$HYP_KEY npx tsx cli.ts warp rebalancer \
                --config ../../fixed-oft-auto.yaml \
                --warp ../../fixed-oft-warp.json \
                --registry ./local-registry \
                --checkFrequency 8000
            ;;
        
        6)
            echo -e "${GREEN}Demo completed! Thanks for testing the OFT rebalancer.${NC}"
            echo ""
            echo "Key takeaways:"
            echo "- ✅ Manual rebalancing works on-demand"
            echo "- ✅ Automatic rebalancer detects and fixes imbalances" 
            echo "- ✅ SafeERC20 approval fix prevents stuck transactions"
            echo "- ✅ LayerZero OFT protocol enables cross-chain transfers"
            echo ""
            echo "See OFT_REBALANCER.md for complete documentation."
            exit 0
            ;;
        
        *)
            echo -e "${RED}Invalid option. Please select 1-6.${NC}"
            ;;
    esac
    
    echo ""
    echo -e "${YELLOW}Press Enter to continue...${NC}"
    read
    echo ""
done