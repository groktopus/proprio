# Plugin Authoring Smoke Example

A Proprio plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Proprio

```bash
pnpm proprio plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@groktopus/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
