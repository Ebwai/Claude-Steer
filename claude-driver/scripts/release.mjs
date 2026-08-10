/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertReleaseNotesBody, parseReleaseArguments } from './release-notes.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DRIVER_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(DRIVER_DIR, '..')
const PACKAGE_PATH = resolve(DRIVER_DIR, 'package.json')
const PACKAGE_LOCK_PATH = resolve(DRIVER_DIR, 'package-lock.json')
const RELEASE_GITIGNORE_PATH = resolve(REPO_DIR, '.gitignore')
const PACKAGE_RELATIVE_PATH = 'claude-driver/package.json'
const PACKAGE_LOCK_RELATIVE_PATH = 'claude-driver/package-lock.json'
const SOURCE_BRANCH = 'develop'
const TEST_REMOTE = 'origin'
const RELEASE_REMOTE = 'release'
const RELEASE_REPOSITORY = 'Ebwai/Claude-Steer'
const WORKFLOW_FILE = 'build.yml'
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const WORKFLOW_POLL_INTERVAL_MS = 10_000
const WORKFLOW_POLL_ATTEMPTS = 60

class ReleaseError extends Error {}

function timestamp() {
  return new Date().toISOString()
}

function log(scope, status, message) {
  console.log(`[${timestamp()}] [release] [${scope}] [${status}] ${message}`)
}

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/\s|["']/u.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

function execute(command, args, { capture = false, acceptedExitCodes = [0] } = {}) {
  log('COMMAND', 'RUN', formatCommand(command, args))

  const result = spawnSync(command, args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    shell: false,
    stdio: capture ? 'pipe' : 'inherit'
  })

  if (result.error) {
    throw new ReleaseError(`无法执行 ${command}: ${result.error.message}`)
  }

  if (!acceptedExitCodes.includes(result.status)) {
    const details = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n')
    throw new ReleaseError(
      `命令执行失败（退出码 ${result.status}）：${formatCommand(command, args)}${details ? `\n${details}` : ''}`
    )
  }

  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? ''
  }
}

function git(args, options) {
  return execute('git', args, options)
}

function gh(args, options) {
  return execute('gh', args, options)
}

function assert(condition, message) {
  if (!condition) throw new ReleaseError(message)
}

function parseJson(text, source) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ReleaseError(`${source} 不是有效 JSON：${error.message}`)
  }
}

function readJson(path, source) {
  return parseJson(readFileSync(path, 'utf8'), source)
}

function refExists(args) {
  return git(args, { capture: true, acceptedExitCodes: [0, 1, 2] }).status === 0
}

function chunk(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export function isPublicReadme(path) {
  const fileName = path.split('/').at(-1) ?? ''
  return /^README(?:[._-].+)?\.md$/iu.test(fileName)
}

export function shouldExcludeFromPublicRelease(path) {
  const segments = path.split('/')
  const directorySegments = segments.slice(0, -1)
  const isInHiddenDirectory = directorySegments.some(
    (segment, index) => segment.startsWith('.') && !(index === 0 && segment === '.github')
  )
  const isInternalDirectory = [
    'docs/',
    'knowledge/',
    'plan/',
    'release-notes/',
    'tools/',
    'claude-driver/knowledge/'
  ].some((prefix) => path.startsWith(prefix))
  const isNonReadmeMarkdown = path.toLowerCase().endsWith('.md') && !isPublicReadme(path)
  return isInHiddenDirectory || isInternalDirectory || isNonReadmeMarkdown
}

function preparePublicRelease(localReleaseBranch, publicReleaseBranch, version) {
  log('STEP 5', 'INFO', `读取 ${RELEASE_REMOTE}/main 的正式仓库历史与 release 专用 .gitignore`)
  git(['fetch', RELEASE_REMOTE, 'main'])
  const releaseGitignore = git(['show', `${RELEASE_REMOTE}/main:.gitignore`], {
    capture: true
  }).stdout
  assert(releaseGitignore, `${RELEASE_REMOTE}/main 缺少 release 专用 .gitignore`)

  git(['switch', '-c', publicReleaseBranch, `${RELEASE_REMOTE}/main`])
  // 只把源码分支的最终文件树覆盖到正式 main 之上，不把内部开发提交历史并入公开仓库。
  git(['read-tree', '--reset', '-u', localReleaseBranch])

  writeFileSync(RELEASE_GITIGNORE_PATH, `${releaseGitignore}\n`, 'utf8')
  const trackedFiles = git(['ls-files', '-z'], { capture: true }).stdout.split('\0').filter(Boolean)
  const exclusions = trackedFiles.filter(shouldExcludeFromPublicRelease)
  log('STEP 5', 'INFO', `正式发布分支将停止跟踪 ${exclusions.length} 个内部文件`)
  for (const paths of chunk(exclusions, 40)) {
    git(['rm', '--cached', '--ignore-unmatch', '--', ...paths])
  }
  const remainingTools = git(['ls-files', '--', 'tools'], { capture: true })
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
  assert(
    remainingTools.length === 0,
    `正式发布分支仍包含开发工具：${remainingTools.join(', ')}`
  )
  log('STEP 5', 'INFO', '已确认正式发布分支不跟踪 tools/ 开发工具')
  git(['add', '--', '.gitignore'])
  git(['commit', '-m', `chore: prepare public v${version} repository`])

  const remainingMarkdown = git(['ls-files', '*.md'], { capture: true })
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
  assert(
    remainingMarkdown.every(isPublicReadme),
    `正式发布分支仍包含非 README 文档：${remainingMarkdown.join(', ')}`
  )
  const hiddenFiles = git(['ls-files'], { capture: true })
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
    .filter((path) => {
      const segments = path.split('/').slice(0, -1)
      return segments.some(
        (segment, index) => segment.startsWith('.') && !(index === 0 && segment === '.github')
      )
    })
  assert(hiddenFiles.length === 0, `正式发布分支仍包含隐藏开发目录文件：${hiddenFiles.join(', ')}`)
}

function readHeadJson(relativePath, source) {
  return parseJson(
    git(['show', `HEAD:${relativePath}`], { capture: true }).stdout,
    `${source}（HEAD）`
  )
}

function isResumableVersionChange(version, worktreeStatus) {
  const statusLines = worktreeStatus
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.trimStart())
  const expectedLines = new Set([`M ${PACKAGE_LOCK_RELATIVE_PATH}`, `M ${PACKAGE_RELATIVE_PATH}`])
  if (
    statusLines.length !== expectedLines.size ||
    statusLines.some((line) => !expectedLines.has(line))
  ) {
    return false
  }

  const currentPackage = readJson(PACKAGE_PATH, 'claude-driver/package.json')
  const currentLock = readJson(PACKAGE_LOCK_PATH, 'claude-driver/package-lock.json')
  if (
    currentPackage.version !== version ||
    currentLock.version !== version ||
    currentLock.packages?.['']?.version !== version
  ) {
    return false
  }

  const headPackage = readHeadJson(PACKAGE_RELATIVE_PATH, 'claude-driver/package.json')
  const headLock = readHeadJson(PACKAGE_LOCK_RELATIVE_PATH, 'claude-driver/package-lock.json')
  const normalizedPackage = structuredClone(currentPackage)
  const normalizedLock = structuredClone(currentLock)
  normalizedPackage.version = headPackage.version
  normalizedLock.version = headLock.version
  normalizedLock.packages[''].version = headLock.packages[''].version

  return (
    JSON.stringify(normalizedPackage) === JSON.stringify(headPackage) &&
    JSON.stringify(normalizedLock) === JSON.stringify(headLock)
  )
}

function precheck(version) {
  log('PRECHECK', 'START', `检查 v${version} 的发布条件`)
  assert(VERSION_PATTERN.test(version), '版本号必须是 x.y.z 格式且不能带 v 前缀，例如 1.0.1')

  execute('git', ['--version'], { capture: true })
  execute('gh', ['--version'], { capture: true })
  gh(['auth', 'status'])
  gh(['repo', 'view', RELEASE_REPOSITORY, '--json', 'nameWithOwner'], { capture: true })

  const branch = git(['branch', '--show-current'], { capture: true }).stdout
  assert(
    branch === SOURCE_BRANCH,
    `当前分支必须是 ${SOURCE_BRANCH}，实际为 ${branch || '(detached HEAD)'}`
  )

  const worktreeStatus = git(['status', '--porcelain'], { capture: true }).stdout
  const isResume = Boolean(worktreeStatus) && isResumableVersionChange(version, worktreeStatus)
  assert(
    !worktreeStatus || isResume,
    '工作区存在非本次版本更新产生的未提交修改，请先提交或暂存后再发布'
  )
  if (isResume) {
    log('PRECHECK', 'INFO', `识别到上次失败后保留的 ${version} 版本修改，将从该现场安全续跑`)
  }

  const remotes = new Set(git(['remote'], { capture: true }).stdout.split(/\r?\n/u).filter(Boolean))
  assert(remotes.has(TEST_REMOTE), `缺少测试仓库远程：${TEST_REMOTE}`)
  assert(remotes.has(RELEASE_REMOTE), `缺少正式仓库远程：${RELEASE_REMOTE}`)

  log('PRECHECK', 'INFO', `读取 ${TEST_REMOTE}/${SOURCE_BRANCH} 以验证本地同步状态`)
  const localHead = git(['rev-parse', 'HEAD'], { capture: true }).stdout
  const remoteHeadResult = git(
    ['ls-remote', '--heads', TEST_REMOTE, `refs/heads/${SOURCE_BRANCH}`],
    { capture: true }
  ).stdout
  const remoteHead = remoteHeadResult.split(/\s/u)[0]
  assert(remoteHead, `${TEST_REMOTE}/${SOURCE_BRANCH} 不存在`)
  assert(
    localHead === remoteHead,
    `本地 ${SOURCE_BRANCH} 未与 ${TEST_REMOTE}/${SOURCE_BRANCH} 完全同步`
  )

  const remoteReleaseBranch = `release/v${version}`
  const preferredLocalBranch = remoteReleaseBranch
  const hasReleaseRootBranch = refExists(['show-ref', '--verify', '--quiet', 'refs/heads/release'])
  const localReleaseBranch = hasReleaseRootBranch ? `release-v${version}` : preferredLocalBranch
  const publicReleaseBranch = `public-v${version}`
  const tag = `v${version}`
  if (hasReleaseRootBranch) {
    log(
      'PRECHECK',
      'INFO',
      `本地已存在 release 分支；本地发布分支改用 ${localReleaseBranch}，远程仍使用 ${remoteReleaseBranch}`
    )
  }
  assert(
    !refExists(['show-ref', '--verify', '--quiet', `refs/heads/${localReleaseBranch}`]),
    `本地分支已存在：${localReleaseBranch}`
  )
  const localDescendants = git(
    ['for-each-ref', '--format=%(refname)', `refs/heads/${localReleaseBranch}/`],
    { capture: true }
  ).stdout
  assert(!localDescendants, `本地存在与目标分支路径冲突的子分支：${localDescendants}`)
  assert(
    !refExists(['show-ref', '--verify', '--quiet', `refs/heads/${publicReleaseBranch}`]),
    `本地正式发布临时分支已存在：${publicReleaseBranch}`
  )
  assert(
    !refExists(['ls-remote', '--exit-code', '--heads', TEST_REMOTE, 'refs/heads/release']),
    `${TEST_REMOTE} 已存在 release 分支，无法创建 ${remoteReleaseBranch}`
  )
  assert(
    !refExists([
      'ls-remote',
      '--exit-code',
      '--heads',
      TEST_REMOTE,
      `refs/heads/${remoteReleaseBranch}`,
      `refs/heads/${remoteReleaseBranch}/*`
    ]),
    `${TEST_REMOTE} 已存在分支或路径冲突：${remoteReleaseBranch}`
  )
  assert(
    !refExists(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]),
    `本地 tag 已存在：${tag}`
  )
  assert(
    !refExists(['ls-remote', '--exit-code', '--tags', RELEASE_REMOTE, `refs/tags/${tag}`]),
    `${RELEASE_REMOTE} 已存在 tag：${tag}`
  )
  assert(
    refExists(['ls-remote', '--exit-code', '--heads', RELEASE_REMOTE, 'refs/heads/main']),
    `${RELEASE_REMOTE}/main 不存在`
  )

  const existingRelease = gh(['api', `repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`], {
    capture: true,
    acceptedExitCodes: [0, 1]
  })
  assert(existingRelease.status !== 0, `GitHub Release 已存在：${tag}`)
  assert(
    existingRelease.stderr.includes('HTTP 404'),
    `无法确认 GitHub Release 是否存在：${existingRelease.stderr || '未知 GitHub API 错误'}`
  )

  const packageJson = readJson(PACKAGE_PATH, 'claude-driver/package.json')
  const packageLock = readJson(PACKAGE_LOCK_PATH, 'claude-driver/package-lock.json')
  assert(typeof packageJson.version === 'string', 'package.json 缺少 version 字段')
  assert(packageLock.packages?.[''], 'package-lock.json 缺少 packages[""] 根包信息')
  log('PRECHECK', 'DONE', '发布条件检查全部通过；下一步将执行首个写操作：更新应用版本')
  return { localReleaseBranch, remoteReleaseBranch, publicReleaseBranch }
}

function updateVersion(version) {
  const packageText = readFileSync(PACKAGE_PATH, 'utf8')
  const lines = packageText.split(/\r?\n/u)
  assert(
    /^ {2}"version": "[^"]+",$/u.test(lines[2] ?? ''),
    'package.json 第 3 行不是预期的 version 字段'
  )

  // 必须先写 package.json；这是整个发布流程的第一个状态修改操作。
  lines[2] = `  "version": "${version}",`
  const packageEol = packageText.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(PACKAGE_PATH, lines.join(packageEol), 'utf8')
  assert(
    readJson(PACKAGE_PATH, 'claude-driver/package.json').version === version,
    'package.json 版本写后校验失败'
  )
  log('STEP 1', 'INFO', `claude-driver/package.json 第 3 行已更新为 ${version}`)

  const lockText = readFileSync(PACKAGE_LOCK_PATH, 'utf8')
  const packageLock = parseJson(lockText, 'claude-driver/package-lock.json')
  packageLock.version = version
  packageLock.packages[''].version = version
  const lockEol = lockText.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(
    PACKAGE_LOCK_PATH,
    `${JSON.stringify(packageLock, null, 2).replaceAll('\n', lockEol)}${lockEol}`,
    'utf8'
  )

  const verifiedLock = readJson(PACKAGE_LOCK_PATH, 'claude-driver/package-lock.json')
  assert(
    verifiedLock.version === version && verifiedLock.packages?.['']?.version === version,
    'package-lock.json 版本写后校验失败'
  )
}

async function step(number, title, action) {
  const scope = `STEP ${number}`
  log(scope, 'START', title)
  try {
    const result = await action()
    log(scope, 'DONE', title)
    return result
  } catch (error) {
    log(scope, 'FAILED', `${title}：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function findTagWorkflowRun(stepScope, tag, commitSha) {
  for (let attempt = 1; attempt <= WORKFLOW_POLL_ATTEMPTS; attempt += 1) {
    log(
      stepScope,
      'INFO',
      `查找 ${tag} 对应的 GitHub Actions（${attempt}/${WORKFLOW_POLL_ATTEMPTS}）`
    )
    const response = gh(
      [
        'api',
        '--method',
        'GET',
        `repos/${RELEASE_REPOSITORY}/actions/runs`,
        '-f',
        'event=push',
        '-f',
        `head_sha=${commitSha}`,
        '-f',
        'per_page=100'
      ],
      { capture: true }
    )
    const payload = parseJson(response.stdout, 'GitHub Actions 响应')
    const run = payload.workflow_runs?.find(
      (candidate) => candidate.head_branch === tag && candidate.path?.endsWith(`/${WORKFLOW_FILE}`)
    )
    if (run) return run
    await sleep(WORKFLOW_POLL_INTERVAL_MS)
  }
  throw new ReleaseError(`等待 ${tag} 对应的 ${WORKFLOW_FILE} 超时`)
}

function ensureDraftRelease(stepScope, tag, releaseNotes) {
  const creation = gh(
    [
      'release',
      'create',
      tag,
      '--repo',
      RELEASE_REPOSITORY,
      '--draft',
      '--verify-tag',
      '--notes-file',
      releaseNotes.path,
      '--title',
      tag
    ],
    { capture: true, acceptedExitCodes: [0, 1] }
  )

  if (creation.status !== 0) {
    log(stepScope, 'INFO', '自动构建可能已先创建 Release，正在写入统一 Release Note')
    gh([
      'release',
      'edit',
      tag,
      '--repo',
      RELEASE_REPOSITORY,
      '--notes-file',
      releaseNotes.path,
      '--title',
      tag
    ])
  }

  const release = parseJson(
    gh(['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'tagName,isDraft,body'], {
      capture: true
    }).stdout,
    'GitHub Release 正文核验结果'
  )
  assert(release.tagName === tag, `GitHub Release tag 不匹配：${release.tagName || '(empty)'}`)
  assertReleaseNotesBody(releaseNotes.content, release.body)
  log(stepScope, 'INFO', `已确认 ${tag} 使用 ${releaseNotes.path} 作为 Release Note`)
}

function verifyReleaseAssets(stepScope, tag) {
  const response = gh(
    ['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'url,isDraft,assets'],
    { capture: true }
  )
  const release = parseJson(response.stdout, 'GitHub Release 响应')
  const assetNames = (release.assets ?? []).map((asset) => asset.name)
  assert(
    assetNames.some((name) => name.endsWith('-setup.exe')),
    'Release 缺少 Windows 安装包（*-setup.exe）'
  )
  assert(
    assetNames.some((name) => name.endsWith('.AppImage')),
    'Release 缺少 Linux 安装包（*.AppImage）'
  )
  log(stepScope, 'INFO', `已核验 Release 安装包：${assetNames.join(', ')}`)
}

function printUsage() {
  console.log('用法：')
  console.log('  npm run release -- <版本号> --notes')
  console.log('  node claude-driver/scripts/release.mjs <版本号> --notes')
  console.log('示例：npm run release -- 1.1.2 --notes')
  console.log('Release Note：release-notes/v<版本号>.md')
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--help' || args[0] === '-h') {
    printUsage()
    return
  }

  let releaseInput
  try {
    releaseInput = parseReleaseArguments(args, REPO_DIR)
  } catch (error) {
    printUsage()
    throw error
  }

  const { version, releaseNotes } = releaseInput
  const tag = `v${version}`
  log('PRECHECK', 'INFO', `Release Note：${releaseNotes.path}`)

  const { localReleaseBranch, remoteReleaseBranch, publicReleaseBranch } = precheck(version)
  await step(1, `更新应用版本为 ${version}`, () => updateVersion(version))
  await step(2, `创建本地发布分支 ${localReleaseBranch}`, () =>
    git(['switch', '-c', localReleaseBranch])
  )
  await step(3, `提交 ${tag} 版本变更`, () => {
    git(['add', '--', 'claude-driver/package.json', 'claude-driver/package-lock.json'])
    git(['commit', '-m', `chore: release ${tag}`])
  })
  await step(4, `推送到 ${TEST_REMOTE}/${remoteReleaseBranch}`, () =>
    git(['push', '-u', TEST_REMOTE, `${localReleaseBranch}:${remoteReleaseBranch}`])
  )
  await step(5, `准备正式仓库分支 ${publicReleaseBranch}`, () =>
    preparePublicRelease(localReleaseBranch, publicReleaseBranch, version)
  )
  await step(6, `推送 ${publicReleaseBranch} 到 ${RELEASE_REMOTE}/main`, () =>
    git(['push', RELEASE_REMOTE, `${publicReleaseBranch}:main`])
  )
  await step(7, `创建注释 tag ${tag}`, () => git(['tag', '-a', tag, '-m', `Release ${tag}`]))
  await step(8, `推送 tag ${tag} 到 ${RELEASE_REMOTE}`, () => git(['push', RELEASE_REMOTE, tag]))
  await step(9, `创建或确认 ${tag} 的草稿 Release`, () =>
    ensureDraftRelease('STEP 9', tag, releaseNotes)
  )

  const commitSha = git(['rev-parse', 'HEAD'], { capture: true }).stdout
  await step(10, `等待 ${tag} 自动构建完成`, async () => {
    const run = await findTagWorkflowRun('STEP 10', tag, commitSha)
    log('STEP 10', 'INFO', `已找到 Actions Run：${run.html_url}`)
    gh(['run', 'watch', String(run.id), '--repo', RELEASE_REPOSITORY, '--exit-status'])
  })
  await step(11, `核验安装包并发布 ${tag} Release`, () => {
    verifyReleaseAssets('STEP 11', tag)
    gh([
      'release',
      'edit',
      tag,
      '--repo',
      RELEASE_REPOSITORY,
      '--notes-file',
      releaseNotes.path,
      '--draft=false',
      '--latest'
    ])
    const published = parseJson(
      gh(['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'url,isDraft,body'], {
        capture: true
      }).stdout,
      'GitHub Release 发布结果'
    )
    assert(published.isDraft === false, `${tag} Release 仍处于草稿状态`)
    assertReleaseNotesBody(releaseNotes.content, published.body)
    log('STEP 11', 'INFO', `Release 地址：${published.url}`)
  })
  await step(12, `切回 ${SOURCE_BRANCH}`, () => git(['switch', SOURCE_BRANCH]))
  await step(13, `删除本地正式发布临时分支 ${publicReleaseBranch}`, () =>
    git(['branch', '-D', publicReleaseBranch])
  )
  await step(14, `删除本地发布分支 ${localReleaseBranch}`, () =>
    git(['branch', '-d', localReleaseBranch])
  )
  await step(15, `删除 ${TEST_REMOTE} 发布分支 ${remoteReleaseBranch}`, () =>
    git(['push', TEST_REMOTE, '--delete', remoteReleaseBranch])
  )

  log('SUMMARY', 'DONE', `${tag} 已完成正式仓库过滤、双远程推送、安装包发布与分支清理`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log('SUMMARY', 'FAILED', error instanceof Error ? error.message : String(error))
    log('SUMMARY', 'INFO', '已停止执行后续步骤；不会自动回滚或清理，请根据日志检查现场后处理')
    process.exitCode = 1
  })
}
