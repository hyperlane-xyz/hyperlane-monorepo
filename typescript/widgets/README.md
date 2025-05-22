# Hyperlane Widgets

Common react components for projects using Hyperlane.

## Installation

```sh
# Install with npm
npm install @hyperlane-xyz/widgets

# Or install with yarn
yarn add @hyperlane-xyz/widgets
```

### Peer dependencies

This package requires `@hyperlane-xyz/sdk`, `react`, and `react-dom`.

## Contents

### Components

- `ChainLogo`: A logo icon for a given chain ID
- `MessageTimeline`: A timeline showing stages of message delivery
- `WideChevron`: A customizable version of Hyperlane's chevron logo

### Hooks

- `useMessage`: Fetch data about a message from the Hyperlane Explorer
- `useMessageStage`: Fetch and compute message delivery stage and timings
- `useMessageTimeline`: Fetch message data for use with `MessageTimeline`

## Storybook Development

This package uses [Storybook](https://storybook.js.org/) for developing and showcasing components.

To run Storybook locally:

1.  Navigate to the `typescript/widgets` directory.
2.  Install dependencies: `yarn install`
3.  Run Storybook: `yarn storybook`

This will open Storybook in your browser, where you can view and interact with the components, including the `WarpRouteVisualiser`.

## Learn more

For more information, see the [Hyperlane documentation](https://docs.hyperlane.xyz/docs/intro).
