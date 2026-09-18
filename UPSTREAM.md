# Slate ⇋ BeatDesign Upstream Management

This document records Slate's long-term relationship with BeatDesign.

## Upstream

```text
https://github.com/BeatAPI/BeatDesign.git
```

## Baseline

```text
21faad3

tag:
beatdesign-baseline-21faad3
```

`21faad3` is the BeatDesign commit Slate forked from. The git tag `beatdesign-baseline-21faad3` marks it locally.

## Fork Strategy

Slate uses an explicit split between two surfaces:

```text
Invariant Core
尽量保持 upstream-compatible
(keep as upstream-compatible as reasonable)

+

Diverged Product Surface
允许长期重度分叉
(allowed to diverge heavily long-term)
```

Slate does **not** intend to remain a tiny patch that never conflicts with upstream. BeatDesign infrastructure feeds the Slate product foundation, and Slate grows its own domain / agent / workflow on top.

## Keep Close To Upstream

Initially, treat these as high-consideration (prefer extension over modification; a change here is not forbidden — it just requires more care and a small diff):

```text
src/core/media/*
security utilities
third_party licensing
command persistence primitives
command receipts
conflict retry infrastructure
provider registry infrastructure
local export infrastructure
```

> This does not mean these files are frozen forever. It means modifications require extra care and should prefer the extension pattern.

## Slate-owned / Diverged

These areas may diverge heavily long-term:

```text
Slate Domain
Drama / Story / Shot models
Slate Agent system
Provider-neutral generation behavior
Canvas domain projection
Slate MCP / Application API
Product UI / UX
Branding
Provider integrations
```

## Upstream Sync Policy

Slate does not pursue:

```text
始终能够 clean merge upstream
(always being able to cleanly merge upstream)
```

Slate primarily tracks upstream for:

```text
security fixes
dependency fixes
important bug fixes
important infrastructure improvements
```

For the diverged surface:

```text
review + selective cherry-pick
```

Avoid manufacturing `shims`, `compatibility wrappers`, or `duplicate architectures` purely to preserve upstream compatibility, unless there is a concrete product need.

## Divergence Matrix

| Area                     | Strategy        | Notes                     |
| ------------------------ | --------------- | ------------------------- |
| Media                    | Track upstream  | Infrastructure            |
| Command persistence      | Track carefully | Core invariant            |
| Provider registry        | Extend first    | Avoid provider hardcoding |
| Domain                   | Slate-owned     | Major divergence          |
| Canvas domain projection | Slate-owned     | Product surface           |
| MCP / Application API    | Slate-owned     | Agent architecture        |
| UI / Branding            | Slate-owned     | Full divergence           |
| third_party              | Track carefully | Licensing/security        |

All future major divergences should update this matrix.

## Sync Procedure

Recommended flow:

```bash
git fetch upstream
git log main..upstream/main
```

Example review flow:

```text
review
↓
select useful commits
↓
cherry-pick
```

Do **not** default to `git merge upstream/main`. Select useful commits deliberately and review diverged-surface changes before cherry-picking.