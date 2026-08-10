/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u
const DIVIDER_PATTERN = /^\s*---\s*$/gmu

const LANGUAGE_CONFIGS = [
  {
    title: 'English',
    feature: 'New Features',
    fixes: 'Bug Fixes',
    summary: 'Release Summary'
  },
  {
    title: '中文',
    feature: '新增功能',
    fixes: '问题修复',
    summary: '版本简述'
  }
]

function fail(message) {
  throw new Error(`Release Note 校验失败：${message}`)
}

function normalize(content) {
  return content
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim()
}

function parseNumberedItems(content, sectionName) {
  const lines = content.split('\n').filter((line) => line.trim())
  if (lines.length === 0) fail(`“${sectionName}”不能是空章节`)

  return lines.map((line, index) => {
    const match = line.match(/^(\d+)\.\s+(.+)$/u)
    if (!match) fail(`“${sectionName}”必须使用连续的 Markdown 数字列表`)
    if (Number(match[1]) !== index + 1) {
      fail(`“${sectionName}”的条目编号必须从 1 开始连续递增`)
    }
    return match[2].trim()
  })
}

function parseLanguageBlock(block, config) {
  const normalized = block.trim()
  const title = `## ${config.title}`
  if (!normalized.startsWith(`${title}\n`)) fail(`缺少或未按顺序放置“${title}”`)

  const body = normalized.slice(title.length).trim()
  const headingPattern = /^### (.+)$/gmu
  const matches = [...body.matchAll(headingPattern)]
  if (matches.length === 0 || body.slice(0, matches[0].index).trim()) {
    fail(`“${title}”必须直接包含规定的三级章节`)
  }

  const allowedHeadings = [config.feature, config.fixes, config.summary]
  const sections = new Map()
  let previousOrder = -1

  matches.forEach((match, index) => {
    const heading = match[1].trim()
    const order = allowedHeadings.indexOf(heading)
    if (order === -1) fail(`“${title}”包含不支持的章节“${heading}”`)
    if (sections.has(heading)) fail(`“${title}”重复包含章节“${heading}”`)
    if (order <= previousOrder) fail(`“${title}”的章节顺序不正确`)

    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length
    sections.set(heading, body.slice(start, end).trim())
    previousOrder = order
  })

  const summary = sections.get(config.summary)
  if (!summary) fail(`“${title}”缺少必填章节“${config.summary}”或其内容为空`)
  if (/^#{1,6}\s/mu.test(summary)) fail(`“${config.summary}”中不能包含额外标题`)

  return {
    featureItems: sections.has(config.feature)
      ? parseNumberedItems(sections.get(config.feature), config.feature)
      : null,
    fixItems: sections.has(config.fixes)
      ? parseNumberedItems(sections.get(config.fixes), config.fixes)
      : null,
    summary
  }
}

export function validateReleaseNotes(content) {
  const normalized = normalize(content)
  const dividers = [...normalized.matchAll(DIVIDER_PATTERN)]
  if (dividers.length !== 1) fail('English 与中文区块之间必须且只能有一个“---”分隔线')

  const divider = dividers[0]
  const english = parseLanguageBlock(normalized.slice(0, divider.index), LANGUAGE_CONFIGS[0])
  const chinese = parseLanguageBlock(
    normalized.slice(divider.index + divider[0].length),
    LANGUAGE_CONFIGS[1]
  )

  const featurePresenceMatches = Boolean(english.featureItems) === Boolean(chinese.featureItems)
  const fixPresenceMatches = Boolean(english.fixItems) === Boolean(chinese.fixItems)
  if (!featurePresenceMatches) fail('New Features 与新增功能必须同时出现或同时省略')
  if (!fixPresenceMatches) fail('Bug Fixes 与问题修复必须同时出现或同时省略')
  if (!english.featureItems && !english.fixItems) fail('新增功能与问题修复不能同时省略')

  if (english.featureItems?.length !== chinese.featureItems?.length) {
    fail('New Features 与新增功能的条目数量必须一致')
  }
  if (english.fixItems?.length !== chinese.fixItems?.length) {
    fail('Bug Fixes 与问题修复的条目数量必须一致')
  }

  return normalized
}

export function loadReleaseNotes(repoDir, version) {
  if (!VERSION_PATTERN.test(version)) {
    fail('版本号必须是 x.y.z 格式且不能带 v 前缀，例如 1.1.2')
  }

  const path = resolve(repoDir, 'release-notes', `v${version}.md`)
  if (!existsSync(path)) fail(`找不到版本文件 release-notes/v${version}.md`)

  const content = validateReleaseNotes(readFileSync(path, 'utf8'))
  return { path, content }
}

export function parseReleaseArguments(args, repoDir) {
  if (args.length !== 2 || args[1] !== '--notes') {
    throw new Error('必须按“<版本号> --notes”传参，正式发布不允许省略 --notes')
  }

  const version = args[0]
  return { version, releaseNotes: loadReleaseNotes(repoDir, version) }
}

export function assertReleaseNotesBody(expected, actual) {
  if (normalize(expected) !== normalize(actual)) {
    throw new Error('GitHub Release 正文与本地 Release Note 文件不一致')
  }
}
