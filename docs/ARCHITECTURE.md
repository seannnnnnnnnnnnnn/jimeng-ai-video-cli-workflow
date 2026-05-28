# Architecture

## Overview

`即梦AI视频CLI工作流` is an Electron desktop application with a Vite renderer and a Node-based Electron main process.

The renderer owns UI state and user interactions. The main process owns local filesystem access, settings, project persistence, CLI execution, account routing, and FFmpeg export.

## Main Modules

- `electron/main.js`: Electron window creation and IPC handlers.
- `electron/store.js`: local settings storage.
- `electron/llm-client.js`: OpenAI-compatible chat completion client.
- `electron/workflow.js`: storyboard, image, and video orchestration.
- `electron/jimeng-runner.js`: safe argument-based wrapper around the `dreamina` CLI.
- `electron/account-router.js`: local multi-account CLI Router.
- `electron/project-manager.js`: workflow project registry.
- `electron/director.js`: scene-level image/video regeneration with backups.
- `electron/editor-project.js`: editor timeline project persistence.
- `electron/editor-exporter.js`: FFmpeg-based video export.
- `src/main.js`: workflow, project gallery, director mode, settings, and account UI.
- `src/editor.js`: media bin, preview player, timeline, transitions, and export UI.

## Workflow State

The workflow intentionally pauses after image generation:

1. LLM generates storyboard data.
2. `dreamina text2image` generates all storyboard images.
3. UI enters image review mode.
4. User reviews images, edits prompts, and regenerates selected images if needed.
5. User explicitly starts `dreamina image2video`.
6. Completed scenes are persisted in the project registry.

This avoids wasting video credits on images that have not been approved.

## Account Routing

All `dreamina` calls go through `JimengRunner`. `JimengRunner` asks `global.accountRouter` for the current CLI environment before spawning the command.

The Router supports:

- default system account using the real HOME;
- isolated accounts using per-account HOME directories;
- isolated macOS keychain databases for additional accounts;
- account switching;
- refresh all credits;
- auto-select first account with enough credits.

## Persistence Paths

The app stores project metadata under:

```text
~/.local/share/jimeng-studio/projects
~/.local/share/jimeng-studio/editor-projects
```

Generated images and videos are stored in the user-selected output directory, defaulting to:

```text
~/Documents/JimengOutput/<timestamp>
```

Settings are stored in Electron `userData`.

## Open Source Boundaries

The repository should contain source code and documentation only. Build outputs, local generated media, credentials, and account state should be excluded and distributed separately through GitHub Releases if needed.
