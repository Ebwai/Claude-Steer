import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeCheckPassed } from './install-app-deps.mjs'

test('accepts a successful Electron native-module check', () => {
  assert.equal(nativeCheckPassed({ status: 0, signal: null, error: undefined }), true)
})

test('requires rebuild when Electron returns a non-zero status', () => {
  assert.equal(nativeCheckPassed({ status: 1, signal: null, error: undefined }), false)
})

test('requires rebuild when the process cannot start or is signalled', () => {
  assert.equal(nativeCheckPassed({ status: null, signal: null, error: new Error('missing') }), false)
  assert.equal(nativeCheckPassed({ status: null, signal: 'SIGTERM', error: undefined }), false)
})
