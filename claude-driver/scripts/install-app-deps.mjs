// Usage: npm run postinstall
// Runtime: Node.js during dependency installation
// Purpose: prefer node-pty's platform prebuild; rebuild native deps only when Electron cannot load it

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')

// JavaScript ESM cannot carry TypeScript return annotations; behavior is covered by node:test.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function nativeCheckPassed(result) {
  return result.status === 0 && result.signal === null && result.error === undefined
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function runInstallAppDeps() {
  const electronPath = require('electron')
  console.log(`[install-app-deps] checking node-pty with Electron: ${electronPath}`)
  const check = spawnSync(
    electronPath,
    ['-e', "const pty=require('node-pty'); if(typeof pty.spawn!=='function') process.exit(2)"],
    {
      cwd: projectDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    },
  )

  if (nativeCheckPassed(check)) {
    console.log('[install-app-deps] node-pty prebuild loads in Electron; native rebuild skipped')
    return 0
  }

  console.warn(
    `[install-app-deps] Electron could not load node-pty; falling back to native rebuild status=${check.status ?? 'null'} signal=${check.signal ?? 'none'}`,
  )
  if (check.error) console.warn('[install-app-deps] native check error:', check.error)
  if (check.stderr) console.warn(check.stderr.trim())

  const builderRoot = path.dirname(require.resolve('electron-builder/package.json'))
  const installerPath = path.join(builderRoot, 'install-app-deps.js')
  console.log(`[install-app-deps] running fallback: ${installerPath}`)
  const rebuild = spawnSync(process.execPath, [installerPath], {
    cwd: projectDir,
    env: process.env,
    stdio: 'inherit',
  })
  if (rebuild.error) {
    console.error('[install-app-deps] fallback failed to start:', rebuild.error)
    return 1
  }
  return rebuild.status ?? 1
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (invokedDirectly) process.exitCode = runInstallAppDeps()
