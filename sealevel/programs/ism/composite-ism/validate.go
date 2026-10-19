package compositeism

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/svm"
)

// validateMultisig rejects threshold 0, threshold above the validator count,
// and duplicate validators.
func validateMultisig(n *IsmNode) uint64 {
	if n.Threshold == 0 || int(n.Threshold) > len(n.Validators) {
		return ErrInvalidConfig
	}
	for i := 1; i < len(n.Validators); i++ {
		for j := 0; j < i; j++ {
			if n.Validators[i] == n.Validators[j] {
				return ErrInvalidConfig
			}
		}
	}
	return svm.Success
}

func validateRateLimited(n *IsmNode) uint64 {
	if n.MaxCapacity == 0 || n.Key == (svm.Pubkey{}) {
		return ErrInvalidConfig
	}
	if !n.Recipient.Some || n.Recipient.Value == ([32]byte{}) {
		return ErrInvalidConfig
	}
	return svm.Success
}

func validateAggregationThreshold(n *IsmNode) uint64 {
	if int(n.Threshold) > len(n.Subs) || n.Threshold == 0 {
		return ErrInvalidConfig
	}
	return svm.Success
}

// validateConfig is processor::validate_config. A preorder walk reports the
// same first error as the Rust recursion: each node's own checks run before
// its children's, children in order.
func validateConfig(programID *svm.Pubkey, root *IsmNode) uint64 {
	routingFound := false
	walk := NewWalker(root)
	for n := walk.Next(); n != nil; n = walk.Next() {
		switch n.Kind {
		case NodeAggregation:
			if code := validateAggregationThreshold(n); code != svm.Success {
				return code
			}
			// FallbackRouting must be the last sub-ISM, transitively.
			for i := 0; i+1 < len(n.Subs); i++ {
				if containsKind(&n.Subs[i], NodeFallbackRouting) {
					return ErrFallbackRoutingNotLast
				}
			}
		case NodeMultisigMessageID:
			if code := validateMultisig(n); code != svm.Success {
				return code
			}
		case NodeRateLimited:
			if code := validateRateLimited(n); code != svm.Success {
				return code
			}
		case NodeRouting:
			if routingFound {
				return ErrMultipleRoutingNodes
			}
			routingFound = true
		case NodeFallbackRouting:
			if n.Key == (svm.Pubkey{}) || n.Key == *programID {
				return ErrInvalidConfig
			}
			if routingFound {
				return ErrMultipleRoutingNodes
			}
			routingFound = true
		case NodeTrustedRelayer:
			if n.Key == (svm.Pubkey{}) {
				return ErrInvalidConfig
			}
		}
	}
	return svm.Success
}

// validateDomainIsm is processor::validate_domain_ism.
func validateDomainIsm(root *IsmNode) uint64 {
	walk := NewWalker(root)
	for n := walk.Next(); n != nil; n = walk.Next() {
		switch n.Kind {
		case NodeRateLimited:
			if code := validateRateLimited(n); code != svm.Success {
				return code
			}
		case NodeAggregation:
			if code := validateAggregationThreshold(n); code != svm.Success {
				return code
			}
		case NodeMultisigMessageID:
			if code := validateMultisig(n); code != svm.Success {
				return code
			}
		case NodeRouting:
			return ErrRoutingInDomainIsm
		case NodeFallbackRouting:
			return ErrFallbackRoutingInDomainIsm
		case NodeTrustedRelayer:
			if n.Key == (svm.Pubkey{}) {
				return ErrInvalidConfig
			}
		case NodePausable:
			return ErrPausableInDomainIsm
		}
	}
	return svm.Success
}
