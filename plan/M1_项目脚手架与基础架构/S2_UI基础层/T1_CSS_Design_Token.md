# T1 — CSS Design Token 系统

## 技术原理

**CSS 自定义属性（Custom Properties）**：
- 通过 `:root` 定义全局 CSS 变量（`--var-name: value`），所有子元素均可继承使用
- 与 Tailwind/CSS-in-JS 相比，原生 CSS 变量的优势：零运行时开销、DevTools 直接可见、与 React 完全解耦
- electron-vite 中 `tokens.css` 在 `src/renderer/src/styles/` 下，在 `main.tsx` 中全局 import 一次即可

**Token 体系来源**：直接从 UI 设计 demo（`global-monitor-page.html`）提取，确保像素级还原。

## 原子步骤

### 步骤 1：创建 tokens.css
包含从 demo 提取的完整颜色、排版、圆角、动画 token。

### 步骤 2：在 main.tsx 全局 import
```tsx
import './styles/tokens.css'
```

### 步骤 3：清理 electron-vite 模板默认样式
删除或清空 `src/renderer/src/assets/` 下的 `base.css`、`main.css` 中与设计不符的内容。

### 步骤 4：验证 DevTools 可见 CSS 变量
`npm run dev` 后 DevTools → Elements → :root 应显示所有 `--bg/--or/--gr/--tx` 变量。

## 验收标准

- [ ] `src/renderer/src/styles/tokens.css` 存在，包含完整变量体系
- [ ] `npm run typecheck` 通过（0 errors）
- [ ] 开发模式下 `document.documentElement.style.getPropertyValue('--bg')` 返回 `#09090B`

## 待优化项

- 后续可扩展亮色主题（添加 `[data-theme="light"]` 选择器覆盖变量值）
