import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveClaudeBin, refreshClaudeBin } from '../pty/PtyManager'

export interface DepStatus {
  name: string
  found: boolean
  version?: string
  path?: string
  error?: string
  canAutoFix: boolean
  /** 下载页面 URL（平台通用，网站自动识别 OS） */
  manualUrl: string
  /** 本平台推荐的一条安装命令（用户可复制到终端执行） */
  installHint: string
}

// ── 平台安装命令生成 ──────────────────────────────────────────────────────────

function getNodeInstallHint(): string {
  switch (process.platform) {
    case 'win32':
      return 'winget install OpenJS.NodeJS.LTS'
    case 'darwin':
      return 'brew install node@22'
    default: {
      // 尝试判断 Linux 发行版
      try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf-8')
        if (/ubuntu|debian/i.test(osRelease)) {
          return 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\nsudo apt-get install -y nodejs'
        }
        if (/fedora|centos|rhel/i.test(osRelease)) {
          return 'sudo dnf install -y nodejs'
        }
        if (/arch/i.test(osRelease)) {
          return 'sudo pacman -S nodejs npm'
        }
      } catch { /* 无法读取 /etc/os-release */ }
      return 'Install Node.js 22+ from https://nodejs.org/en/download'
    }
  }
}

function getGitInstallHint(): string {
  switch (process.platform) {
    case 'win32':
      return 'winget install Git.Git'
    case 'darwin':
      return 'xcode-select --install   # includes git\n# or: brew install git'
    default: {
      try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf-8')
        if (/ubuntu|debian/i.test(osRelease)) return 'sudo apt-get install -y git'
        if (/fedora|centos|rhel/i.test(osRelease)) return 'sudo dnf install -y git'
        if (/arch/i.test(osRelease)) return 'sudo pacman -S git'
      } catch { /* 无法读取 */ }
      return 'Install Git from https://git-scm.com/downloads/linux'
    }
  }
}

function getNodeDownloadUrl(): string {
  return 'https://nodejs.org/en/download'
}

function getGitDownloadUrl(): string {
  switch (process.platform) {
    case 'win32': return 'https://git-scm.com/download/win'
    case 'darwin': return 'https://git-scm.com/download/mac'
    default: return 'https://git-scm.com/downloads/linux'
  }
}

// ── Node.js 检查 ────────────────────────────────────────────────────────────

function findNodeBin(): string | null {
  // 1. PATH 中的 node
  try {
    const cmd = process.platform === 'win32'
      ? execSync('where node', { encoding: 'utf-8', timeout: 3000 }).trim().split(/\r?\n/)[0]
      : execSync('which node', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (cmd && fs.existsSync(cmd)) return cmd
  } catch { /* 不在 PATH */ }

  // 2. nvm (Unix)
  if (process.platform !== 'win32') {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    try {
      const versions = fs.readdirSync(nvmDir).sort().reverse()
      for (const ver of versions) {
        const candidate = path.join(nvmDir, ver, 'bin', 'node')
        if (fs.existsSync(candidate)) return candidate
      }
    } catch { /* nvm 不存在 */ }
  }

  // 3. nvm-windows
  if (process.platform === 'win32') {
    const nvmDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nvm')
    try {
      const versions = fs.readdirSync(nvmDir).filter(d => /^v?\d/.test(d)).sort().reverse()
      for (const ver of versions) {
        const candidate = path.join(nvmDir, ver, 'node.exe')
        if (fs.existsSync(candidate)) return candidate
      }
    } catch { /* nvm-windows 不存在 */ }
  }

  return null
}

/** Claude Code CLI 要求的最低 Node.js 版本 */
const MIN_NODE_VERSION = 18

export function checkNode(): DepStatus {
  try {
    const bin = findNodeBin() ?? 'node'
    const raw = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim()
    const version = raw.replace(/^v/, '')
    const major = parseInt(version.split('.')[0], 10)
    if (major < MIN_NODE_VERSION) {
      console.warn(`[Deps] node ${version} is too old (need >= ${MIN_NODE_VERSION})`)
      return {
        name: 'Node.js',
        found: false,
        version,
        canAutoFix: false,
        manualUrl: getNodeDownloadUrl(),
        installHint: getNodeInstallHint(),
        error: `Node.js v${version} found but v${MIN_NODE_VERSION}+ is required.\nUpgrade with: ${getNodeInstallHint()}`
      }
    }
    console.log(`[Deps] node found: v${version} at ${bin}`)
    return { name: 'Node.js', found: true, version, path: bin, canAutoFix: false, manualUrl: '', installHint: '' }
  } catch (e: any) {
    console.warn(`[Deps] node check failed:`, e.message)
    return {
      name: 'Node.js',
      found: false,
      canAutoFix: false,
      manualUrl: getNodeDownloadUrl(),
      installHint: getNodeInstallHint(),
      error: 'Node.js v18+ is required. Install it first, then re-check.'
    }
  }
}

// ── npm 检查 ────────────────────────────────────────────────────────────────

function findNpmBin(): string | null {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  try {
    const cmd = process.platform === 'win32'
      ? execSync('where npm', { encoding: 'utf-8', timeout: 3000 }).trim().split(/\r?\n/)[0]
      : execSync('which npm', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (cmd && fs.existsSync(cmd)) return cmd
  } catch { /* 不在 PATH */ }

  if (process.platform !== 'win32') {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    try {
      const versions = fs.readdirSync(nvmDir).sort().reverse()
      for (const ver of versions) {
        const candidate = path.join(nvmDir, ver, 'bin', `npm${ext}`)
        if (fs.existsSync(candidate)) return candidate
      }
    } catch { /* nvm 不存在 */ }
  }

  return null
}

export function checkNpm(): DepStatus {
  try {
    const bin = findNpmBin() ?? 'npm'
    const version = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim()
    console.log(`[Deps] npm found: ${version}`)
    return { name: 'npm', found: true, version, path: bin, canAutoFix: false, manualUrl: '', installHint: '' }
  } catch (e: any) {
    console.warn(`[Deps] npm check failed:`, e.message)
    return {
      name: 'npm',
      found: false,
      canAutoFix: false,
      manualUrl: getNodeDownloadUrl(),
      installHint: getNodeInstallHint(),
      error: 'npm is bundled with Node.js.\nRe-install Node.js to get npm.'
    }
  }
}

// ── Git 检查 ────────────────────────────────────────────────────────────────

export function checkGit(): DepStatus {
  try {
    const version = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim()
    console.log(`[Deps] git found: ${version}`)
    return { name: 'Git', found: true, version, canAutoFix: false, manualUrl: '', installHint: '' }
  } catch (e: any) {
    console.warn(`[Deps] git check failed:`, e.message)
    return {
      name: 'Git',
      found: false,
      canAutoFix: false,
      manualUrl: getGitDownloadUrl(),
      installHint: getGitInstallHint(),
      error: 'Git is required for project version control.'
    }
  }
}

// ── Claude Code CLI 检查 ────────────────────────────────────────────────────

export function checkClaude(): DepStatus {
  const binPath = resolveClaudeBin()
  console.log(`[Deps] Checking claude binary: ${binPath}`)
  try {
    const version = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 15000 }).trim()
    console.log(`[Deps] claude found: ${version}`)
    return { name: 'Claude Code CLI', found: true, version, path: binPath, canAutoFix: false, manualUrl: '', installHint: '' }
  } catch (e: any) {
    console.warn(`[Deps] claude check failed:`, e.message)
    return {
      name: 'Claude Code CLI',
      found: false,
      path: binPath,
      error: e.message,
      canAutoFix: true,
      manualUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
      installHint: 'npm install -g @anthropic-ai/claude-code',
    }
  }
}

// ── 自动安装 ────────────────────────────────────────────────────────────────

export async function autoInstallClaude(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      console.log('[Deps] Attempting: npm install -g @anthropic-ai/claude-code')
      const result = execSync('npm install -g @anthropic-ai/claude-code', {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: 'pipe'
      })
      console.log('[Deps] npm install succeeded:', result.slice(-200))
      // 刷新 PtyManager 中缓存的 claude 路径
      const newPath = refreshClaudeBin()
      console.log(`[Deps] claude refreshed: ${newPath}`)
      resolve({ ok: true, message: `Installed successfully at ${newPath}` })
    } catch (e: any) {
      const errMsg = e.stderr?.toString() ?? e.message ?? 'Unknown error'
      console.error('[Deps] npm install failed:', errMsg.slice(-300))
      resolve({ ok: false, message: `Auto-install failed:\n${errMsg.slice(0, 300)}` })
    }
  })
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

export function checkAllDependencies(): DepStatus[] {
  console.log('[Deps] Running dependency checks...')
  return [checkNode(), checkNpm(), checkGit(), checkClaude()]
}
