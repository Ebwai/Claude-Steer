import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const featureDir = resolve(testDir, '../../renderer/src/features/project-monitor')
const canvasDir = resolve(featureDir, 'canvas')

const sessionFrameSource = readFileSync(
  resolve(canvasDir, 'SessionFrameNode.tsx'),
  'utf8'
)
const sessionFrameStyles = readFileSync(
  resolve(canvasDir, 'SessionFrameNode.css'),
  'utf8'
)
const processTimelineSource = readFileSync(
  resolve(featureDir, 'ProcessTimeline.tsx'),
  'utf8'
)
const processLineCanvasSource = readFileSync(
  resolve(canvasDir, 'ProcessLineCanvas.tsx'),
  'utf8'
)

describe('history Agent text selection policy', () => {
  it('scopes the selection class to historical SessionFrameNode instances', () => {
    expect(sessionFrameSource).toContain("source === 'history' ? 'sfn-frame-history'")
    expect(sessionFrameSource).toContain('history text selection scope enabled')
  })

  it('enables selection for content and disables it for controls and metadata', () => {
    const selectableClasses = [
      '.sfn-agent-label',
      '.ptl-user-text',
      '.ptl-assistant-text',
      '.ptl-tool-box',
      '.sab-user-text',
      '.sab-assistant-text',
      '.sab-tool-box',
      '.ins-badge',
      '.resource-item'
    ]
    const nonSelectableClasses = [
      '.sfn-header',
      '.sfn-footer',
      '.sfn-tokens',
      '.sfn-duration',
      '.sfn-milestone-badge',
      '.ptl-action-bar',
      '.ptl-expand-btn',
      '.resource-toggle',
      '.sab-header',
      '.sab-expand-btn',
      '.ins-badge-expand'
    ]

    for (const className of selectableClasses) {
      expect(sessionFrameStyles).toContain(`.sfn-frame-history ${className}`)
      expect(sessionFrameStyles).toContain('user-select: text')
    }
    for (const className of nonSelectableClasses) {
      expect(sessionFrameStyles).toContain(`.sfn-frame-history ${className}`)
      expect(sessionFrameStyles).toContain('user-select: none')
    }
  })

  it('keeps collapsed text as the rendered copy source and expands it in place', () => {
    expect(processTimelineSource).toContain("lines.slice(0, MAX_USER_LINES).join('\\n')")
    expect(processTimelineSource).toContain("text.slice(0, MAX_TEXT) + '…'")
    expect(processTimelineSource).toContain('{isLong && !expanded ? text.slice(0, MAX_TEXT) + \'…\' : text}')
    expect(processTimelineSource).not.toContain('navigator.clipboard')
  })

  it('preserves the ReactFlow non-draggable canvas contract', () => {
    expect(processLineCanvasSource).toContain('nodesDraggable={false}')
    expect(processLineCanvasSource).toContain('nodesConnectable={false}')
    expect(processLineCanvasSource).toContain('panOnDrag={[1, 2]}')
  })
})
