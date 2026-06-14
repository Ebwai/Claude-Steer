// 使用方法：由 ProjectSettingsBar.tsx 在点击设置项时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：设置栏下拉浮层——支持单选（radio）和多选（checkbox）两种模式，
//           点击外部区域自动关闭

import React, { useEffect, useRef } from 'react'
import { useT } from '../../i18n'
import './SettingsDropdown.css'

// ── 单选项类型 ────────────────────────────────────────────────────────────────

export interface RadioOption {
  value: string
  label: string
  description?: string  // 悬停 tooltip 说明
}

// ── 多选项类型 ────────────────────────────────────────────────────────────────

export interface CheckboxOption {
  value: string
  label: string
  description?: string
}

// ── 分组多选类型 ─────────────────────────────────────────────────────────────

export interface CheckboxGroup {
  /** 分组标题，显示为分隔行 */
  label: string
  items: CheckboxOption[]
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SettingsDropdownRadioProps {
  mode: 'radio'
  options: RadioOption[]
  value: string
  onChange: (value: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

interface SettingsDropdownCheckboxProps {
  mode: 'checkbox'
  options: CheckboxOption[]
  values: string[]
  onChange: (values: string[]) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

interface SettingsDropdownGroupedCheckboxProps {
  mode: 'grouped-checkbox'
  groups: CheckboxGroup[]
  values: string[]
  onChange: (values: string[]) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

type SettingsDropdownProps =
  | SettingsDropdownRadioProps
  | SettingsDropdownCheckboxProps
  | SettingsDropdownGroupedCheckboxProps

// ── 组件 ──────────────────────────────────────────────────────────────────────

function SettingsDropdown(props: SettingsDropdownProps): React.JSX.Element {
  const { t } = useT()
  const { onClose, anchorRef } = props
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 计算浮层位置（锚定到触发元素下方）
  const anchorRect = anchorRef.current?.getBoundingClientRect()
  const top  = anchorRect ? anchorRect.bottom + 4 : 0
  const left = anchorRect ? anchorRect.left : 0

  // 点击外部区域关闭
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      const target = e.target as Node
      if (dropdownRef.current && !dropdownRef.current.contains(target) &&
          anchorRef.current && !anchorRef.current.contains(target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose, anchorRef])

  return (
    <div
      ref={dropdownRef}
      className="sdrop-panel"
      style={{ top, left }}
    >
      {props.mode === 'radio' && (
        <div className="sdrop-list">
          {props.options.map((opt) => (
            <label
              key={opt.value}
              className={`sdrop-item ${props.value === opt.value ? 'sdrop-item-active' : ''}`}
              title={opt.description}
            >
              <input
                type="radio"
                name="sdrop-radio"
                value={opt.value}
                checked={props.value === opt.value}
                onChange={() => {
                  props.onChange(opt.value)
                  onClose()
                }}
              />
              <span className="sdrop-label">{opt.label}</span>
              {opt.description && (
                <span className="sdrop-desc">{opt.description}</span>
              )}
            </label>
          ))}
        </div>
      )}

      {props.mode === 'checkbox' && (
        <div className="sdrop-list">
          {props.options.length === 0 && (
            <div className="sdrop-empty">{t('projectMonitor.settingsDropdown.noProjects')}</div>
          )}
          {props.options.map((opt) => {
            const checked = props.values.includes(opt.value)
            return (
              <label key={opt.value} className="sdrop-item">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? props.values.filter((v) => v !== opt.value)
                      : [...props.values, opt.value]
                    props.onChange(next)
                  }}
                />
                <span className="sdrop-label" title={opt.description}>{opt.label}</span>
              </label>
            )
          })}
        </div>
      )}

      {props.mode === 'grouped-checkbox' && (
        <div className="sdrop-list">
          {props.groups.every(g => g.items.length === 0) && (
            <div className="sdrop-empty">{t('projectMonitor.settingsDropdown.noProjects')}</div>
          )}
          {props.groups.filter(g => g.items.length > 0).map((group) => (
            <div key={group.label} className="sdrop-group">
              <div className="sdrop-group-header">{group.label}</div>
              {group.items.map((opt) => {
                const checked = props.values.includes(opt.value)
                return (
                  <label key={opt.value} className="sdrop-item sdrop-item-indented">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? props.values.filter((v) => v !== opt.value)
                          : [...props.values, opt.value]
                        props.onChange(next)
                      }}
                    />
                    <span className="sdrop-label" title={opt.description}>{opt.label}</span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default SettingsDropdown
