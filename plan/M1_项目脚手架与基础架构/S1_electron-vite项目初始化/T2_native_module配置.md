# T2 — 配置 native module 支持（node-pty）

## 技术原理

**Node.js native addon (.node 文件)**：
- `node-pty` 包含 C++ 编译的 `.node` 二进制文件（`pty.node`），用于创建 PTY 伪终端。
- 该文件与具体 Node.js/Electron ABI 版本绑定——普通 Node.js 编译的 `.node` 无法在 Electron 中使用，必须针对目标 Electron 版本重新编译。

**electron-vite 的 main 进程外部化机制**：
- main 进程 Rollup 默认将 `node_modules` 全部标记为 `external`（不 bundle），运行时通过 `require()` 加载。
- 因此 node-pty 会以原生 `require('node-pty')` 形式加载，`.node` 文件直接被 Node.js 加载器处理——这是正确的。
- **注意**：renderer 进程严禁 import node-pty（renderer 运行在 Chromium sandbox 中，无法访问 native addon）。

**electron-builder install-app-deps**：
- package.json 的 `postinstall` 已配置此命令，每次 `npm install` 后自动触发。
- 等效于调用 `@electron/rebuild`，针对 `package.json` 中 `dependencies` 的所有 native addon 进行重编。

## 原子步骤

### 步骤 1：安装 node-pty（写入 dependencies）
```bash
cd /home/tony/CLAUDE_Steer/claude-driver
npm install node-pty
```
> postinstall 自动触发 `electron-builder install-app-deps`，针对 Electron 39.x 重编 node-pty

### 步骤 2：安装 chokidar（文件监听，M2 S3 使用，无 native 依赖）
```bash
npm install chokidar
```

### 步骤 3：验证 electron.vite.config.ts 主进程外部化配置
检查 main 目标是否无需额外配置（electron-vite 默认行为）。
若有问题则在 main 配置中显式添加：
```ts
main: {
  build: {
    rollupOptions: {
      external: ['node-pty']
    }
  }
}
```

### 步骤 4：在主进程入口验证 node-pty 可导入
在 `src/main/index.ts` 顶部临时添加测试代码，构建后验证不报错：
```ts
// 临时验证，验证后删除
import pty from 'node-pty'
console.log('node-pty loaded:', typeof pty.spawn)
```

### 步骤 5：运行 typecheck 确认无类型错误
```bash
npm run typecheck:node
```

## 验收标准

- [x] `npm install node-pty` 后 postinstall 执行，输出 "completed installing native dependencies"
- [x] `src/main/index.ts` 中 `import pty from 'node-pty'` 不报 TypeScript 错误
- [x] `npm run typecheck:node` 通过
- [x] main 进程可正常加载 node-pty（electron-vite build 后可运行）

## 待优化项

- 打包发布时需要在 `electron-builder.yml` 配置 `extraResources` 包含 `.node` 文件（发布阶段处理）
