import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldExcludeFromPublicRelease } from './release.mjs'

test('public release excludes tracked development tools', () => {
  assert.equal(shouldExcludeFromPublicRelease('tools/block_sync/start.py'), true)
  assert.equal(shouldExcludeFromPublicRelease('tools/block_sync/README.md'), true)
  assert.equal(shouldExcludeFromPublicRelease('tools/block_sync/registry.json'), true)
})

test('public release keeps application source files', () => {
  assert.equal(shouldExcludeFromPublicRelease('claude-driver/src/main/index.ts'), false)
  assert.equal(shouldExcludeFromPublicRelease('claude-driver/package.json'), false)
})

test('tools prefix does not overmatch similarly named product paths', () => {
  assert.equal(shouldExcludeFromPublicRelease('claude-driver/src/tools-panel/index.ts'), false)
})
