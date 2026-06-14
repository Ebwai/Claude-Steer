// 使用方法：<TreeView nodes={tree} renderLabel={fn} defaultExpanded={true} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：可展开树形视图——用于 Plan 树（M/S/T 层级）和上下文面板文件树

import { useState, type FC, type ReactNode } from 'react'
import './TreeView.css'

export interface TreeNode {
  id: string
  label: ReactNode
  children?: TreeNode[]
  /** 是否默认展开，仅顶层有效（子节点继承 defaultExpanded） */
  defaultExpanded?: boolean
}

interface TreeViewProps {
  nodes: TreeNode[]
  /** 自定义渲染每个节点 label（可选，不传则直接渲染 node.label） */
  renderLabel?: (node: TreeNode) => ReactNode
  /** 是否默认全部展开，默认 false */
  defaultExpanded?: boolean
  /** 缩进层级宽度（px），默认 12 */
  indentPx?: number
  className?: string
}

interface TreeNodeItemProps {
  node: TreeNode
  depth: number
  renderLabel?: (node: TreeNode) => ReactNode
  defaultExpanded: boolean
  indentPx: number
}

const TreeNodeItem: FC<TreeNodeItemProps> = ({
  node,
  depth,
  renderLabel,
  defaultExpanded,
  indentPx
}) => {
  const hasChildren = node.children && node.children.length > 0
  const [open, setOpen] = useState(node.defaultExpanded ?? defaultExpanded)

  return (
    <div className="tree-node">
      <div
        className="tree-node__row"
        style={{ paddingLeft: depth * indentPx }}
        onClick={() => hasChildren && setOpen(v => !v)}
      >
        {/* 展开/折叠箭头 */}
        <span className={`tree-node__arrow ${hasChildren ? '' : 'tree-node__arrow--hidden'} ${open ? 'tree-node__arrow--open' : ''}`}>
          ›
        </span>

        <span className="tree-node__label">
          {renderLabel ? renderLabel(node) : node.label}
        </span>
      </div>

      {hasChildren && open && (
        <div className="tree-node__children">
          {node.children!.map(child => (
            <TreeNodeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              renderLabel={renderLabel}
              defaultExpanded={defaultExpanded}
              indentPx={indentPx}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const TreeView: FC<TreeViewProps> = ({
  nodes,
  renderLabel,
  defaultExpanded = false,
  indentPx = 12,
  className = ''
}) => {
  return (
    <div className={`tree-view ${className}`}>
      {nodes.map(node => (
        <TreeNodeItem
          key={node.id}
          node={node}
          depth={0}
          renderLabel={renderLabel}
          defaultExpanded={defaultExpanded}
          indentPx={indentPx}
        />
      ))}
    </div>
  )
}

export default TreeView
