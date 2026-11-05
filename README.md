# Spare SDK

Spare 眼镜应用的开源工具链：SpareScript 编译器、`.spa` 打包和签名、`spare` 命令行。

- **零依赖**：只用 Node 自带的模块；源码是 TypeScript，Node ≥ 23.6 直接运行，不用编译。
- **和平台一致**：编出来的 `.spa` 和平台云端构建的结果**逐字节相同**（见下文「一致性测试」）。

## 安装

```bash
git clone https://github.com/spare-glass/sdk && cd sdk
alias spare="node $PWD/src/cli.ts"
```

（npm 包 `@spare-glass/sdk` 稍后发布。VS Code 插件见 [vscode-spare](https://github.com/spare-glass/vscode-spare)。）

## 用法

```bash
spare new my-app            # 新建一个最小应用
spare check my-app          # 编译 + 清单校验，几十毫秒出结果
spare build my-app          # 编译并用你的开发者密钥签名，输出 my-app.spa
spare install my-app --qr   # 构建 + 终端里显示二维码，手机扫一下装到眼镜
spare keygen                # 生成开发者密钥（默认 ~/.spare/dev_ed25519.key）
```

### 扫码装到眼镜

`spare install my-app --qr` 会构建、签名，然后在局域网里临时提供这个 `.spa`，终端里显示一个二维码。用 Spare App「工坊 › 创作 › 扫码安装」扫它，App 下载、核对 SHA-256、装到眼镜。

- 手机和电脑要在同一个 Wi-Fi；App 要打开「开发者模式」（未审核的包只能这样装）。
- 默认下载一次就结束，10 分钟没人扫也会结束；`--keep` 可以反复扫。多网卡时用 `--host 192.168.x.x` 指定地址。
- 链接是 `spare://workshop/sideload?url=…&sha256=…&id=…&name=…`，协议见 [spec/distribution.md](https://github.com/spare-glass/spec/blob/main/distribution.md#扫码侧载)。
- App 端的「扫码安装」入口随新版 Spare App 上线；在那之前请用 `spare build` 加「上传应用」。
- 也可以不扫码：`spare build` 出来的 `.spa` 在 App「工坊 › 创作 › 上传应用」里选文件安装。上架仍然走平台：`git push` 后云端构建会再跑一遍模拟器和压力场景。

## 当成库用

```ts
import { build } from '@spare-glass/sdk';
const { pkg, info } = build({ manifest: appJsonText, script: mainSsText }, seed32Bytes);
```

## 目录

| 文件 | 内容 |
|---|---|
| `src/compiler.ts` | 词法、语法、字节码生成（含 `on control` / `ctl` / `ctl_set` 语法糖） |
| `src/manifest.ts` | `app.json` 校验：权限与请求、控件、界面元素 |
| `src/pack.ts` | PNG 解码成 16 级灰度、分节、CRC32、Ed25519 签名 |
| `src/qr.ts` | 二维码编码器（版本 1–40、L/M/Q/H），输出终端字符或 SVG |
| `src/sideload.ts` | 扫码侧载：局域网临时服务 + `spare://workshop/sideload` 链接 |
| `src/cli.ts` | `spare` 命令行 |
| `test/parity.mjs` | 和平台编译器的逐字节对比 |
| `test/qr.mjs` | 二维码往返测试：用独立解码器 jsQR 解回来（`npm i --no-save jsqr@1.4.0 && node test/qr.mjs`） |

包格式见 [spec/package-format.md](https://github.com/spare-glass/spec/blob/main/package-format.md)，语言见 [spec/language.md](https://github.com/spare-glass/spec/blob/main/language.md)。

## 一致性测试

`test/parity.mjs` 把 `templates`、`examples` 和 `test/fixtures` 里的每个应用，分别用这个 SDK 和平台编译器编译，再逐字节比较。fixtures 覆盖了图标、5 种 PNG 格式、全部 7 种控件、各种语言写法，以及 3 个必须报错的情况。目前全部一致。

运行：`SPAC=<你的应用仓库>/tools/spac.py node test/parity.mjs`（平台给每个应用仓库自带一份 `tools/spac.py`；想测图标要用装了 Pillow 的 Python：`PYTHON=…`）。

唯一允许的差别：应用没有 `icon.png` 时，平台用系统字体把名字首字画成图标，SDK 画一个空心方块。

## 还没有

- 本地模拟器（要等眼镜运行时开源，见 [RFC 路线图](https://github.com/spare-glass/rfcs)）
- 发布到 npm

## 许可

Apache-2.0
