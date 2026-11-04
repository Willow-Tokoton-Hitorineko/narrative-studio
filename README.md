# Narrative Studio · 写作间

![写作间封面](https://raw.githubusercontent.com/Willow-Tokoton-Hitorineko/narrative-studio/6bca961d2c0a7d86550a3df6a0ce540044f59c39/media/atelier-uhd-cover.webp)

我做写作间，是想把以前没写完的文章接着写。平时随手记下的点子，也想挑几个出来，认真写成一篇。

想改哪儿就圈哪儿，顺手写一句为什么要改。AI 给出的那版会摆在旁边，原文还在，读完可以换，也可以丢掉。想往下写，把光标放到要接的地方就行。

[看一次改写](#一句话是怎么改的) · [在电脑上试用](#快速试用) · [最近在改什么](#开发进度) · [下载源码](https://github.com/Willow-Tokoton-Hitorineko/narrative-studio/releases/tag/v0.1.0-preview.2)

## 一句话是怎么改的

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/Willow-Tokoton-Hitorineko/narrative-studio/6bca961d2c0a7d86550a3df6a0ce540044f59c39/media/atelier-uhd-poster.png">
  <img src="https://raw.githubusercontent.com/Willow-Tokoton-Hitorineko/narrative-studio/6bca961d2c0a7d86550a3df6a0ce540044f59c39/media/atelier-qhd-loop.gif" alt="在正文中选中一段，输入改写指令，对照候选，确认替换，再撤销">
</picture>

录像里选的是一段写脚步声的文字，要求是「写得更克制，保留门外的悬念」。读完候选，点确认替换，再撤销，原来的几句就回来了。用的是虚构样稿和离线演示。 [看 4K 视频](https://willow-tokoton-hitorineko.github.io/narrative-studio/#film) · [看静态画面](https://raw.githubusercontent.com/Willow-Tokoton-Hitorineko/narrative-studio/6bca961d2c0a7d86550a3df6a0ce540044f59c39/media/atelier-uhd-poster.png)

如果还只有一个点子，可以先聊人物和剧情。比如主角今晚非得做什么，谁会拦她。想清楚的部分先记下来，再排关系、卷章和开篇。

## 快速试用

准备好 Node.js 24 和 pnpm 11，在终端运行下面几行。

```sh
git clone https://github.com/Willow-Tokoton-Hitorineko/narrative-studio.git
cd narrative-studio
pnpm install --frozen-lockfile
pnpm build
pnpm studio:build
pnpm demo
```

在浏览器打开终端给出的地址，点「接着已有文章写」。《末班车没有到站》已经放在里面，可以直接拿它试。每次启动演示都会新建一份临时样稿。

[导入自己的稿子、导出和配置 DeepSeek](docs/quickstart.md)

## 稿件怎样保存

正文在本机。可以导入 TXT 或 Markdown，也可以导出一份带走。每次采纳都会留下原稿版本和来源。候选生成后如果你又改了原文，工作台会要求按新版本重来。人物关系确认后才会进入正式设定。

演示无需密钥。自己接入 DeepSeek 时，先看清这次会发送哪些上下文，再确认发送。模型调用按服务商计费。

## 开发进度

现在是 **v0.1.0-preview.2**，需要从源码启动。导入、续写、选区改写、构思和导出都可以试用。首发的 137 项测试在 Windows 通过，另外在浏览器里试过确认写入和撤销。 [验证记录](docs/verification.md)

下一轮先拿长一点的样稿试导入，看看章序对不对、续写时光标会不会跑、改过的地方好不好找。构思这边，想让只有一句梗概的人也能理出第一章要发生的事。再往后会整理 Windows 上的下载和启动步骤。

有哪一步用着别扭，欢迎带一小段可公开的样稿来聊。 [提个问题](https://github.com/Willow-Tokoton-Hitorineko/narrative-studio/issues)

[MIT 许可证](LICENSE) · [插画与许可](https://willow-tokoton-hitorineko.github.io/narrative-studio/credits.html) · [依赖说明](NOTICE)
