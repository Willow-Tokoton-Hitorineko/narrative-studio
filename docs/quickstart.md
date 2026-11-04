# 本地使用

Node.js 24 和 pnpm 11 安装好后，在仓库根目录运行以下命令。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm studio:build
```

## 先试一份独立样稿

运行 `pnpm demo`，在本机浏览器打开终端打印的完整地址。退出时按 Ctrl+C。每次启动创建一份临时样稿与运行目录，终端会显示目录位置。

## 建立自己的稿件库

以下使用 Windows PowerShell。使用自己选定、独立于 Git 仓库的 Vault 和运行目录。第一次启动会创建作品与本地工作区。

```powershell
$writingVault = Join-Path $env:USERPROFILE 'NarrativeVault'
$writingRuntime = Join-Path $env:LOCALAPPDATA 'NarrativeStudioPublic'
pnpm cli init --vault "$writingVault" --appdata "$writingRuntime" --title "我的作品"
pnpm cli studio --vault "$writingVault" --appdata "$writingRuntime"
```

在终端保留服务运行，从浏览器打开打印的完整本地地址。用「自己写文章」创建文章，或通过工作台顶部「导入」打开 TXT / Markdown。通过顶部「导出」保存可读副本。完整历史应备份 Vault，导出文本用于交换或阅读。

首次打开有会话凭据的本地 URL。分享截图时请裁掉地址栏。服务面向单机使用，保持默认回环地址。

## 可选的真实 DeepSeek

在**启动工作台的同一终端**设置 `DEEPSEEK_API_KEY` 环境变量，再启动自己的工作台。请勿把 Key 填进工作台、命令历史或提交到 Git。在「连接与设置」切换真实模式，检查本次发送内容和授权提示。可通过 `DEEPSEEK_MODEL` 指定模型，费用按服务商账单计算。

`pnpm demo` 使用独立工作区，并清除该进程继承的模型配置。公开发行验证使用 Mock。

## 反馈

优先附虚构短文、复现步骤、系统版本和实际结果。涉及漏洞或隐私的问题请走仓库的私密漏洞报告入口。
