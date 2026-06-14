// 使用方法：electron-vite 自动加载此配置文件
// 编译说明：此文件在构建工具层执行（Node.js），不参与 Electron 运行时
// 代码说明：electron-vite 三目标（main/preload/renderer）独立构建配置
//           @shared alias 指向 src/shared/（main/preload/renderer 三方共用类型）

import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared':   resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
