import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assertReleaseNotesBody,
  parseReleaseArguments,
  validateReleaseNotes
} from './release-notes.mjs'

const validNotes = `## English

### New Features

1. Added a release workflow.

### Release Summary

This release focuses on release consistency.

---

## 中文

### 新增功能

1. 新增统一发布流程。

### 版本简述

本次更新核心围绕发布一致性展开。`

test('validates bilingual notes with optional sections omitted symmetrically', () => {
  assert.equal(validateReleaseNotes(validNotes), validNotes)
})

test('the maintained template passes the same validation used by release', () => {
  const template = readFileSync(new URL('../../release-notes/TEMPLATE.md', import.meta.url), 'utf8')
  assert.doesNotThrow(() => validateReleaseNotes(template))
})

test('rejects mismatched bilingual item counts', () => {
  const invalidNotes = validNotes.replace(
    '1. 新增统一发布流程。',
    '1. 新增统一发布流程。\n2. 新增第二项。'
  )
  assert.throws(() => validateReleaseNotes(invalidNotes), /条目数量必须一致/u)
})

test('requires the explicit --notes argument before loading a note file', () => {
  assert.throws(() => parseReleaseArguments(['1.1.2'], process.cwd()), /不允许省略 --notes/u)
})

test('accepts line-ending differences when checking the published body', () => {
  assert.doesNotThrow(() =>
    assertReleaseNotesBody(validNotes, `${validNotes.replace(/\n/gu, '\r\n')}\n`)
  )
})
