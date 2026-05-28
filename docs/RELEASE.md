# Release Guide

## What Goes Into Git

Commit:

- `src/`
- `electron/`
- `docs/`
- `package.json`
- `package-lock.json`
- `vite.config.js`
- `README.md`
- `LICENSE`
- `.gitignore`
- `SECURITY.md`

Do not commit:

- `node_modules/`
- `dist/`
- `dist-electron/`
- `package_build/`
- `.exe`, `.dmg`, `.blockmap`, `.zip`
- API keys or account state

## Release Assets

Installer files should be uploaded to GitHub Releases, not committed to the repository.

Current local artifacts found during project cleanup:

```text
dist-electron/即梦工作流 Studio-1.0.0-arm64.dmg
即梦工作流 Studio Setup 1.0.0.exe
package_build/dist-electron/即梦工作流 Studio 1.0.0.exe
```

For a public release, prefer rebuilding after final smoke testing so filenames match the product name:

```text
即梦AI视频CLI工作流-1.0.0-arm64.dmg
即梦AI视频CLI工作流-Setup-1.0.0.exe
```

## Pre-release Checklist

- [ ] Confirm `dreamina --version` works.
- [ ] Confirm default account credit refresh works.
- [ ] Add at least one isolated account and confirm it does not reuse the default account.
- [ ] Run a small workflow: LLM storyboard -> image generation -> image review.
- [ ] Regenerate one image from edited prompt.
- [ ] Continue to video generation for one short project.
- [ ] Import result into editor and export a short MP4.
- [ ] Confirm no API keys, local accounts, generated media, or installers are staged.
- [ ] Build macOS and Windows installers.
- [ ] Upload installers to GitHub Releases.

## Suggested Release Copy

### Short

即梦AI视频CLI工作流：把即梦 CLI 变成桌面端 AI 视频生产线，支持 LLM 分镜、图片审核重生成、图生视频、多账号积分调度和剪辑导出。

### Long

这是一个面向 AI 短剧、漫剧和分镜视频创作者的桌面工作流工具。它把故事创意拆成镜头级分镜，用即梦 CLI 批量生成图片和视频，并在视频消耗积分前提供图片审核与二次提示词调整。内置本地多账号 CLI Router，可在多个即梦账号之间切换并自动选择有积分账号。

## Known Notes

- This is an unofficial workflow tool.
- Users must install and log in to the official `dreamina` CLI.
- macOS builds are unsigned unless a Developer ID certificate is configured.
- Windows builds may trigger SmartScreen until releases have reputation.
