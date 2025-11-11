#!/usr/bin/env python3
"""
Visualize Hyperlane token fee curve implementations.

Usage:
    python visualize_fees.py [--maxfee MAXFEE] [--halfamount HALFAMOUNT] [--maxamount MAXAMOUNT]

Generates PNG and SVG visualizations of Linear, Progressive, and Regressive fee curves.
"""
import numpy as np
import matplotlib.pyplot as plt
import argparse

def linear_fee(amount, max_fee, half_amount):
    """
    Linear Fee: fee = min(maxFee, (amount * maxFee) / (2 * halfAmount))
    """
    uncapped = (amount * max_fee) / (2 * half_amount)
    return np.minimum(uncapped, max_fee)

def progressive_fee(amount, max_fee, half_amount):
    """
    Progressive Fee: fee = (maxFee * amount^2) / (halfAmount^2 + amount^2)
    """
    if isinstance(amount, np.ndarray):
        return np.where(amount == 0, 0,
                       (max_fee * amount**2) / (half_amount**2 + amount**2))
    return 0 if amount == 0 else (max_fee * amount**2) / (half_amount**2 + amount**2)

def regressive_fee(amount, max_fee, half_amount):
    """
    Regressive Fee: fee = (maxFee * amount) / (halfAmount + amount)
    """
    denominator = half_amount + amount
    return np.where(denominator == 0, 0, (max_fee * amount) / denominator)

def create_visualizations(max_fee=1000, half_amount=10000, max_amount=50000, output_prefix='fee_curves'):
    """
    Create comprehensive fee curve visualizations.

    Args:
        max_fee: Maximum fee in token units
        half_amount: Amount at which fee = maxFee/2
        max_amount: Maximum amount to visualize
        output_prefix: Prefix for output files
    """
    # Generate amount range
    amounts = np.linspace(0, max_amount, 1000)

    # Calculate fees for each model
    linear_fees = linear_fee(amounts, max_fee, half_amount)
    progressive_fees = progressive_fee(amounts, max_fee, half_amount)
    regressive_fees = regressive_fee(amounts, max_fee, half_amount)

    # Calculate fee percentages (avoiding division by zero)
    linear_pct = np.where(amounts > 0, (linear_fees / amounts) * 100, 0)
    progressive_pct = np.where(amounts > 0, (progressive_fees / amounts) * 100, 0)
    regressive_pct = np.where(amounts > 0, (regressive_fees / amounts) * 100, 0)

    # Color scheme
    colors = {
        'linear': '#2E86AB',
        'progressive': '#A23B72',
        'regressive': '#F18F01'
    }

    # Create figure with subplots
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))
    fig.suptitle('Hyperlane Token Fee Structures Comparison', fontsize=18, fontweight='bold', y=0.995)

    # ========== Plot 1: Absolute Fees ==========
    ax1 = axes[0, 0]
    ax1.plot(amounts, linear_fees, label='Linear', linewidth=2.5, color=colors['linear'])
    ax1.plot(amounts, progressive_fees, label='Progressive', linewidth=2.5, color=colors['progressive'])
    ax1.plot(amounts, regressive_fees, label='Regressive', linewidth=2.5, color=colors['regressive'])
    ax1.axhline(y=max_fee, color='red', linestyle='--', alpha=0.4, linewidth=1.5, label=f'maxFee = {max_fee:,}')
    ax1.axvline(x=half_amount, color='gray', linestyle='--', alpha=0.3, linewidth=1.5)
    ax1.axhline(y=max_fee/2, color='gray', linestyle='--', alpha=0.3, linewidth=1.5)

    # Mark intersection point
    ax1.scatter([half_amount], [max_fee/2], color='red', s=150, zorder=5,
                marker='o', edgecolors='black', linewidths=2, label=f'Intersection ({half_amount:,}, {max_fee/2:.0f})')

    ax1.set_xlabel('Transfer Amount (tokens)', fontsize=12, fontweight='bold')
    ax1.set_ylabel('Absolute Fee (tokens)', fontsize=12, fontweight='bold')
    ax1.set_title('Absolute Fee vs Transfer Amount', fontsize=13, fontweight='bold', pad=10)
    ax1.legend(loc='lower right', fontsize=10, framealpha=0.95)
    ax1.grid(True, alpha=0.3, linestyle=':')
    ax1.set_xlim(0, max_amount)
    ax1.set_ylim(0, max_fee * 1.1)

    # ========== Plot 2: Fee Percentages ==========
    ax2 = axes[0, 1]
    ax2.plot(amounts, linear_pct, label='Linear', linewidth=2.5, color=colors['linear'])
    ax2.plot(amounts, progressive_pct, label='Progressive', linewidth=2.5, color=colors['progressive'])
    ax2.plot(amounts, regressive_pct, label='Regressive', linewidth=2.5, color=colors['regressive'])
    ax2.axvline(x=half_amount, color='gray', linestyle='--', alpha=0.3, linewidth=1.5,
                label=f'halfAmount = {half_amount:,}')

    ax2.set_xlabel('Transfer Amount (tokens)', fontsize=12, fontweight='bold')
    ax2.set_ylabel('Fee Percentage (%)', fontsize=12, fontweight='bold')
    ax2.set_title('Fee Percentage vs Transfer Amount', fontsize=13, fontweight='bold', pad=10)
    ax2.legend(loc='best', fontsize=10, framealpha=0.95)
    ax2.grid(True, alpha=0.3, linestyle=':')
    ax2.set_xlim(0, max_amount)

    # Dynamic ylim for percentage plot
    max_pct = max(
        np.max(linear_pct[amounts <= half_amount*2]),
        np.max(progressive_pct[amounts <= half_amount*2]),
        np.max(regressive_pct[amounts <= half_amount*2])
    )
    ax2.set_ylim(0, min(20, max_pct * 1.2))

    # ========== Plot 3: Zoomed View Around halfAmount ==========
    ax3 = axes[1, 0]
    zoom_mask = (amounts >= half_amount * 0.1) & (amounts <= half_amount * 2.5)
    ax3.plot(amounts[zoom_mask], linear_fees[zoom_mask], label='Linear',
             linewidth=2.5, color=colors['linear'])
    ax3.plot(amounts[zoom_mask], progressive_fees[zoom_mask], label='Progressive',
             linewidth=2.5, color=colors['progressive'])
    ax3.plot(amounts[zoom_mask], regressive_fees[zoom_mask], label='Regressive',
             linewidth=2.5, color=colors['regressive'])

    ax3.axhline(y=max_fee/2, color='red', linestyle='--', alpha=0.4, linewidth=1.5,
                label=f'maxFee/2 = {max_fee/2:.0f}')
    ax3.axvline(x=half_amount, color='gray', linestyle='--', alpha=0.5, linewidth=1.5,
                label=f'halfAmount = {half_amount:,}')
    ax3.scatter([half_amount], [max_fee/2], color='red', s=150, zorder=5,
                marker='o', edgecolors='black', linewidths=2)

    ax3.set_xlabel('Transfer Amount (tokens)', fontsize=12, fontweight='bold')
    ax3.set_ylabel('Absolute Fee (tokens)', fontsize=12, fontweight='bold')
    ax3.set_title(f'Zoomed View: All Curves Intersect at ({half_amount:,}, {max_fee/2:.0f})',
                  fontsize=13, fontweight='bold', pad=10)
    ax3.legend(loc='best', fontsize=10, framealpha=0.95)
    ax3.grid(True, alpha=0.3, linestyle=':')

    # ========== Plot 4: Comparison Table ==========
    ax4 = axes[1, 1]
    ax4.axis('off')

    # Generate test amounts
    test_amounts = [
        half_amount * 0.2,
        half_amount * 0.5,
        half_amount,
        half_amount * 2,
        half_amount * 5
    ]

    table_data = []
    for amt in test_amounts:
        lin_fee = float(linear_fee(amt, max_fee, half_amount))
        prog_fee = float(progressive_fee(amt, max_fee, half_amount))
        reg_fee = float(regressive_fee(amt, max_fee, half_amount))

        table_data.append([
            f'{int(amt):,}',
            f'{lin_fee:.1f}',
            f'{lin_fee/amt*100:.2f}%' if amt > 0 else '0%',
            f'{prog_fee:.1f}',
            f'{prog_fee/amt*100:.2f}%' if amt > 0 else '0%',
            f'{reg_fee:.1f}',
            f'{reg_fee/amt*100:.2f}%' if amt > 0 else '0%'
        ])

    # Create table
    table = ax4.table(
        cellText=table_data,
        colLabels=['Amount', 'Linear\nFee', 'Linear\n%', 'Progressive\nFee', 'Progressive\n%', 'Regressive\nFee', 'Regressive\n%'],
        cellLoc='center',
        loc='center',
        bbox=[0, 0.1, 1, 0.8]
    )
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1, 2.2)

    # Style header row
    for i in range(7):
        table[(0, i)].set_facecolor('#D3D3D3')
        table[(0, i)].set_text_props(weight='bold', fontsize=9)

    # Alternate row colors
    for i in range(1, len(test_amounts) + 1):
        for j in range(7):
            if i % 2 == 0:
                table[(i, j)].set_facecolor('#F5F5F5')

            # Highlight the intersection point row (halfAmount)
            if test_amounts[i-1] == half_amount:
                table[(i, j)].set_facecolor('#FFE6E6')

    ax4.text(0.5, 0.95, 'Fee Comparison at Key Transfer Amounts',
             ha='center', va='top', fontsize=13, fontweight='bold',
             transform=ax4.transAxes)

    # Add parameter info at bottom
    param_text = f'Parameters: maxFee = {max_fee:,} | halfAmount = {half_amount:,}'
    ax4.text(0.5, 0.02, param_text, ha='center', va='bottom',
             fontsize=9, style='italic', transform=ax4.transAxes)

    plt.tight_layout()

    # Save as PNG
    png_file = f'{output_prefix}.png'
    plt.savefig(png_file, dpi=300, bbox_inches='tight', facecolor='white')
    print(f'✓ PNG visualization saved: {png_file}')

    # Save as SVG
    svg_file = f'{output_prefix}.svg'
    plt.savefig(svg_file, format='svg', bbox_inches='tight', facecolor='white')
    print(f'✓ SVG visualization saved: {svg_file}')

    plt.close()

    # Print summary
    print(f'\n{"="*70}')
    print('KEY INSIGHTS')
    print(f'{"="*70}')
    print(f'\nParameters: maxFee = {max_fee:,}, halfAmount = {half_amount:,}')
    print(f'\nAll three curves intersect at (halfAmount={half_amount:,}, fee={max_fee/2:.0f})')

    print('\n1. LINEAR FEE')
    print('   Formula: fee = min(maxFee, (amount × maxFee) / (2 × halfAmount))')
    print(f'   • Simple linear growth until reaching maxFee at amount = {2*half_amount:,}')
    print('   • Predictable, easy to understand')
    print('   • Fee percentage constant until cap, then decreases')

    print('\n2. PROGRESSIVE FEE')
    print('   Formula: fee = (maxFee × amount²) / (halfAmount² + amount²)')
    print('   • Fee percentage increases up to halfAmount, then decreases')
    print(f'   • Peak fee percentage around halfAmount ({half_amount:,})')
    print('   • Asymptotically approaches maxFee but never reaches it')
    print('   • Encourages mid-sized transfers')

    print('\n3. REGRESSIVE FEE')
    print('   Formula: fee = (maxFee × amount) / (halfAmount + amount)')
    print('   • Fee percentage continuously decreases as amount increases')
    print('   • Asymptotically approaches maxFee but never reaches it')
    print('   • Encourages larger transfers, penalizes small transfers')
    print('   • Most favorable for whales')

    print(f'\n{"="*70}\n')

def main():
    parser = argparse.ArgumentParser(
        description='Visualize Hyperlane token fee curves',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument('--maxfee', type=float, default=1000,
                       help='Maximum fee in token units')
    parser.add_argument('--halfamount', type=float, default=10000,
                       help='Amount at which fee equals maxFee/2')
    parser.add_argument('--maxamount', type=float, default=50000,
                       help='Maximum amount to visualize')
    parser.add_argument('--output', type=str, default='fee_curves',
                       help='Output file prefix (without extension)')

    args = parser.parse_args()

    print(f'\nGenerating fee curve visualizations...')
    print(f'Parameters: maxFee={args.maxfee:,}, halfAmount={args.halfamount:,}, maxAmount={args.maxamount:,}\n')

    create_visualizations(
        max_fee=args.maxfee,
        half_amount=args.halfamount,
        max_amount=args.maxamount,
        output_prefix=args.output
    )

if __name__ == '__main__':
    main()
