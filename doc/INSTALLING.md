# Running from source

Proprio has no hosted installer, published registry package, or supported production release. Do not use the upstream install or update commands.

The initial target is Linux self-hosting. For contributor validation in a disposable environment, use the version of Node.js supported by `package.json` and the pinned pnpm version. In the repository root:

```sh
pnpm install --frozen-lockfile
pnpm proprio --help
pnpm dev
```

Keep the development instance separate from other installs and back up any database before running a different source revision against its data. See [Developing](DEVELOPING.md) and [CLI reference](CLI.md) for local use.
