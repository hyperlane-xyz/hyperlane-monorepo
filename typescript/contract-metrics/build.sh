#!/bin/sh

REPOSITORY=gcr.io/clabs-optics/optics-monitor

# Uses the first argument as the tag if it's present, otherwise uses
# the latest commit hash.
TAG=$1
if [ -z $TAG ]; then
    # This grabs the most recent commit hash - be sure to commit changes
    # before running this.
    TAG=$(git rev-parse HEAD)
fi

FULL_IMAGE=$REPOSITORY:$TAG

echo "Building $FULL_IMAGE"

docker build --platform amd64 -t $FULL_IMAGE .