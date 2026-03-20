# Github Proxy

## Overview

Github Proxy is a CloudFlare Worker that makes a Github API requests using an API key. This authenticated method allows higher limits than the non-authenticated mode.

## Keys

Acquire a Github api key by creating a new [fine-grained personal access token](https://github.com/settings/tokens).

## Local Development

Prerequisites: Copy the `.dev.vars.example` and add the Github API key.

Development is managed by the Wrangler CLI. To start dev mode execute `pnpm dev`. This will start a local server.

## Testing

Unit tests can be executed using `pnpm test`.

## Deployment

Execute `pnpm deploy` to deploy to production. Note that the deployment requires permissions. To deploy to a staging environment use `pnpm deploy:staging`. Use `pnpm deploy:key` to attach the Github key to the Worker.
