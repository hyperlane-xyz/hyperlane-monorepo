#!/bin/sh
set -eu

role=${HYPERLANE_AGENT_ROLE:-relayer}
if [ "$#" -gt 0 ]; then
    case "$1" in
        relayer|validator|scraper)
            role=$1
            shift
            ;;
    esac
fi

case "$role" in
    relayer|validator|scraper)
        exec "/opt/hyperlane/bin/$role" "$@"
        ;;
    *)
        printf '%s\n' 'usage: hyperlane [relayer|validator|scraper] [agent arguments]' >&2
        exit 64
        ;;
esac
