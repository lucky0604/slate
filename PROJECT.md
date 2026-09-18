# Slate

## 1. Project Identity

```text
Name:       Slate
Origin:     BeatDesign fork
Baseline:   21faad3
Repository: https://github.com/lucky0604/slate.git
Upstream:   https://github.com/BeatAPI/BeatDesign.git
```

Slate originated as a fork of BeatDesign and is in the process of becoming an independent product. It is not a rebranded BeatDesign, nor a ComfyUI replacement, nor simply an AI image/video generation client.

## 2. Vision

Slate is an **Agent-native AI filmmaking / storytelling workspace**.

The first phase focuses on:

```text
AI 短剧 (AI short dramas)
AI 视频叙事 (AI video storytelling)
多镜头故事生成 (multi-shot story generation)
```

However, the product name and underlying architecture are **not** bound to `Drama`. Over time Slate can extend to:

```text
短剧
广告
短视频
故事视频
MV
影视预演
AI filmmaking
```

Because of this, the core abstractions center on domain concepts that are category-agnostic, not on any single model or video genre:

```text
Project
Story
Episode
Scene
Shot
Character
Asset
Timeline
Generation
Agent
```

## 3. Product Principles

```text
Asset-first

Domain-first

Canvas as projection

Timeline as final assembly

Provider-neutral

Agent-safe

Local-first when possible

Cloud / BYOK / Self-hosted friendly
```

## 4. Architecture Direction

The long-term layering is:

```text
Agents
    ↓
Application Layer (Command / API)
    ↓
Domain
    ↓
Project / Asset
    ↓
Canvas / Timeline (projection / assembly)
    ↓
Generation Providers
```

Key commitments (recorded here for direction; implemented in later phases):

- **Asset-first** — Generated results become project `Asset`s first, then are referenced from Canvas / Timeline / Shot. Assets are the stable boundary for media outcomes and provenance.
- **Canvas as projection** — Canvas is a representation / interaction surface. Domain objects (`Character`, `Scene`, `Shot`, `Storyboard`, …) must not treat Canvas data as their only source of truth.
- **Timeline as final assembly** — Timeline is responsible for Video, Audio, Subtitle, BGM, SFX, Transition, Final Assembly, and Export. It is not the business database for Story / Episode / Scene / Shot.
- **Domain independent** — Slate adds an independent Domain Layer (Project → Story / Episode / Scene / Shot / Character / Assets), managed by a relational data model. Canvas and Timeline are projections / assembly of that domain.
- **Provider replaceable** — Models are not the product kernel. LLM, Image, Video, and Audio capabilities are all reachable through clear Provider / Adapter boundaries.

This section is only an overview. For the full detail, defer to the formal architecture audit.

## 5. Development Stage

Slate is currently in:

```text
Foundation
```

Formal Drama feature development has not started. Planned phases for reference:

```text
Phase 0  Baseline Verification
Phase 1  Provider Decoupling / Command Infrastructure
Phase 2  Domain Foundation
Phase 3  Shot → Generation → Asset → Timeline
Phase 4  Agent Layer
Phase 5  Continuity
```

These are directional only. The authoritative phase definitions follow `docs/architecture/BEATDESIGN_ARCHITECTURE_AUDIT.md` and subsequent ADRs.

## 6. Source of Truth

Detailed architecture analysis is governed by:

```text
docs/architecture/BEATDESIGN_ARCHITECTURE_AUDIT.md
```

Phase implementation notes:

```text
docs/architecture/phase1b-completion-providers.md
docs/architecture/phase1c-provider-neutral-submission.md
docs/architecture/phase1d-command-handler-registry.md
```

Significant future architecture decisions should be recorded using ADRs or architecture docs, not left only in chat logs or commit messages.

If any summary here conflicts with the formal architecture audit or a later ADR, **the formal audit and ADRs take precedence**.