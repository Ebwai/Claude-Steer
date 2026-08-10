# claude-driver

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm ci
```

Use npm with the committed `package-lock.json`. Do not install this workspace with pnpm:
pnpm may block Electron and native-module lifecycle scripts, leaving the Electron package
without its platform binary. The postinstall check reuses a compatible `node-pty` prebuild
and falls back to a source rebuild only when Electron cannot load it.

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
