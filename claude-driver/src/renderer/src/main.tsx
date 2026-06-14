// 使用方法：由 electron-vite 自动作为 renderer 入口加载，不直接执行
// 编译说明：此文件编译为 browser bundle，在 Chromium renderer 进程中运行
// 代码说明：React 渲染进程入口——挂载根组件，全局 import Design Token 样式

import './styles/tokens.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
