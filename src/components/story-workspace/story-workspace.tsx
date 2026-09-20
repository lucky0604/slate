import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Clapperboard, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { WorkspaceSelect } from '@/components/app/workspace-select';
import { useTranslations } from '@/core/workspace-lib/shims/next-intl';
import type { StoryCommandResult } from '@/core/story/client';
import { ShotCanvas } from './shot-canvas';
import { useStoryWorkspace } from './use-story-workspace';

function StoryWorkspaceContent({ projectId }: { projectId: string }) {
  const t = useTranslations('StoryWorkspace');
  const workspace = useStoryWorkspace(projectId);

  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newSceneTitle, setNewSceneTitle] = useState('');
  const [newShotDescription, setNewShotDescription] = useState('');
  const [creatingStory, setCreatingStory] = useState(false);

  const selectedShot = useMemo(
    () =>
      workspace.currentShots.find((shot) => shot.id === workspace.selectedShotId) ??
      null,
    [workspace.currentShots, workspace.selectedShotId]
  );

  const reportFailure = (result: StoryCommandResult | null | undefined) => {
    if (!result) return;
    if (result.code === 'REVISION_CONFLICT') {
      toast.error(t('revisionConflict', { entity: t('title') }), {
        description: t('staleShotRefresh'),
      });
    } else if (result.code === 'NOT_FOUND') {
      toast.error(t('notFound'));
    } else if (!result.ok) {
      toast.error(result.message || t('commandFailed'));
    }
  };

  const handleCreateStory = async () => {
    if (!newStoryTitle.trim()) return;
    setCreatingStory(true);
    try {
      const result = await workspace.createStory(newStoryTitle.trim());
      reportFailure(result);
      if (result?.ok) setNewStoryTitle('');
    } finally {
      setCreatingStory(false);
    }
  };

  const handleCreateScene = async () => {
    const result = await workspace.createScene(
      newSceneTitle.trim() || t('newSceneName')
    );
    reportFailure(result);
    if (result?.ok) setNewSceneTitle('');
  };

  const handleCreateShot = async () => {
    const result = await workspace.createShot(
      newShotDescription.trim() || t('newShotDescription')
    );
    reportFailure(result);
    if (result?.ok) setNewShotDescription('');
  };

  // Story selector options (multiple stories).
  const storyOptions = (workspace.readModel?.stories ?? []).map((story) => ({
    value: story.id,
    label: story.title || t('title'),
  }));

  const stories = workspace.readModel?.stories ?? [];
  const scenes =
    workspace.currentStory && workspace.currentStory.id === workspace.readModel?.story?.id
      ? (workspace.readModel?.scenes ?? [])
      : [];

  // --------------------------------------------------------------------
  // Empty state: project has no Story yet
  // --------------------------------------------------------------------
  if (workspace.readModel && stories.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="mb-3 flex items-center gap-2 text-[var(--beat-graph)]">
            <BookOpen className="size-5" aria-hidden="true" />
            <span className="text-sm font-semibold">{t('title')}</span>
          </div>
          <h2 className="text-lg font-semibold text-[var(--beat-text-1)]">
            {t('createStoryTitle')}
          </h2>
          <p className="mt-1 text-sm text-[var(--beat-text-2)]">
            {t('createStoryDescription')}
          </p>
          <div className="mt-4 flex gap-2">
            <input
              value={newStoryTitle}
              onChange={(event) => setNewStoryTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreateStory();
              }}
              placeholder={t('title')}
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-[var(--beat-text-1)] outline-none placeholder:text-white/35 focus:ring-2 focus:ring-[var(--beat-graph)]/50"
            />
            <button
              type="button"
              disabled={creatingStory || !newStoryTitle.trim()}
              onClick={() => void handleCreateStory()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--beat-graph)]/20 px-4 text-sm font-medium text-[var(--beat-graph)] transition hover:bg-[var(--beat-graph)]/30 disabled:opacity-40"
            >
              {t('createStoryButton')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Left: Story/Scene Navigator */}
      {/* ------------------------------------------------------------------ */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/[0.07] bg-[var(--beat-surface)]/40">
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          <BookOpen className="size-4 text-[var(--beat-graph)]" aria-hidden="true" />
          <span className="text-sm font-semibold text-[var(--beat-text-1)]">
            {t('title')}
          </span>
        </div>

        {storyOptions.length > 1 ? (
          <div className="px-3 pt-3">
            <WorkspaceSelect
              value={workspace.currentStoryId ?? ''}
              options={storyOptions}
              onChange={(value) => workspace.selectStory(value)}
              ariaLabel={t('storySelectorLabel')}
              leadingIcon={<BookOpen className="size-3.5" />}
            />
          </div>
        ) : null}

        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--beat-text-2)]">
            {t('scenesTitle')}
          </span>
          <button
            type="button"
            onClick={() => void handleCreateScene()}
            aria-label={t('addScene')}
            className="inline-flex size-6 items-center justify-center rounded-md text-[var(--beat-text-2)] transition hover:bg-white/10 hover:text-white"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {scenes.length === 0 ? (
            <div className="mx-1 my-2 rounded-xl border border-dashed border-white/10 p-3 text-center">
              <p className="text-xs font-medium text-[var(--beat-text-1)]">
                {t('createFirstScene')}
              </p>
              <p className="mt-1 text-[11px] text-[var(--beat-text-2)]">
                {t('createSceneEmptyDescription')}
              </p>
              <button
                type="button"
                onClick={() => void handleCreateScene()}
                className="mt-2 inline-flex items-center gap-1 rounded-full bg-[var(--beat-graph)]/15 px-3 py-1 text-xs font-medium text-[var(--beat-graph)] hover:bg-[var(--beat-graph)]/25"
              >
                <Plus className="size-3" aria-hidden="true" />
                {t('addScene')}
              </button>
            </div>
          ) : (
            <ul className="space-y-1">
              {scenes.map((scene, index) => {
                const active =
                  scene.id ===
                  (workspace.currentScene?.id ?? workspace.readModel?.currentScene.scene?.id);
                return (
                  <li key={scene.id}>
                    <button
                      type="button"
                      onClick={() => workspace.selectScene(scene.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                        active
                          ? 'bg-[var(--beat-graph)]/15 text-white'
                          : 'text-[var(--beat-text-2)] hover:bg-white/[0.05] hover:text-white'
                      }`}
                    >
                      <span className="w-6 shrink-0 text-[11px] font-semibold tabular-nums text-[var(--beat-graph)]">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {scene.title || t('newSceneName')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* Center: Shot Canvas */}
      {/* ------------------------------------------------------------------ */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--beat-text-1)]">
              {workspace.currentStory?.title || t('title')}
            </div>
            <div className="text-xs text-[var(--beat-text-2)]">
              {t('scenesTitle')} ·{' '}
              {workspace.currentScene?.title || t('newSceneName')} (
              {workspace.currentShots.length})
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateShot()}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--beat-graph)]/15 px-3.5 text-sm font-medium text-[var(--beat-graph)] transition hover:bg-[var(--beat-graph)]/25"
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('addShot')}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ShotCanvas
            document={workspace.projectionDocument}
            shots={workspace.currentShots}
            selectedShotId={workspace.selectedShotId}
            onSelectShot={workspace.selectShot}
            onMoveShot={workspace.moveShotCard}
            onAddShot={() => void handleCreateShot()}
          />
        </div>
      </main>

      {/* ------------------------------------------------------------------ */}
      {/* Right: Shot Inspector */}
      {/* ------------------------------------------------------------------ */}
      {selectedShot ? (
        <ShotInspector
          shotId={selectedShot.id}
          description={selectedShot.description}
          durationMs={selectedShot.durationMs}
          position={selectedShot.position}
          onSave={async (patch) => {
            const next = await workspace.updateSelectedShot(patch);
            if (next?.code === 'REVISION_CONFLICT') {
              toast.error(t('revisionConflict', { entity: t('title') }), {
                description: t('staleShotRefresh'),
              });
              await workspace.refreshWorkspace();
              return false;
            }
            if (!next?.ok) {
              reportFailure(next);
              return false;
            }
            return true;
          }}
          onDelete={async () => {
            const next = await workspace.deleteShot();
            if (next?.code === 'REVISION_CONFLICT') {
              toast.error(t('revisionConflict', { entity: t('title') }), {
                description: t('staleShotRefresh'),
              });
              await workspace.refreshWorkspace();
              return false;
            }
            if (!next?.ok) {
              reportFailure(next);
              return false;
            }
            return true;
          }}
        />
      ) : (
        <aside className="flex w-72 shrink-0 flex-col items-center justify-center gap-2 border-l border-white/[0.07] bg-[var(--beat-surface)]/40 px-4 text-center">
          <Clapperboard className="size-6 text-[var(--beat-text-3)]" aria-hidden="true" />
          <p className="text-sm text-[var(--beat-text-2)]">{t('noSelectedShot')}</p>
        </aside>
      )}
    </div>
  );
}

function ShotInspector({
  shotId,
  description,
  durationMs,
  position,
  onSave,
  onDelete,
}: {
  shotId: string;
  description: string;
  durationMs: number | null;
  position: number;
  onSave: (patch: {
    description?: string;
    durationMs?: number | null;
    position?: number;
  }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const t = useTranslations('StoryWorkspace');
  const [desc, setDesc] = useState(description);
  const [durationSec, setDurationSec] = useState(
    durationMs != null ? String(durationMs / 1000) : ''
  );
  const [pos, setPos] = useState(String(position));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDesc(description);
    setDurationSec(durationMs != null ? String(durationMs / 1000) : '');
    setPos(String(position));
  }, [shotId, description, durationMs, position]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const hasDurationChange = durationSec.trim() !== '';
      await onSave({
        description: desc.trim() || description,
        ...(hasDurationChange
          ? { durationMs: Math.round(Number.parseFloat(durationSec) * 1000) }
          : {}),
        ...(pos.trim() !== '' ? { position: Math.max(0, Number.parseInt(pos, 10) || 0) } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-white/[0.07] bg-[var(--beat-surface)]/40">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <Clapperboard className="size-4 text-[var(--beat-graph)]" aria-hidden="true" />
        <span className="text-sm font-semibold text-[var(--beat-text-1)]">
          {t('title')}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--beat-text-2)]">
            {t('detailPositionLabel')}
          </span>
          <input
            value={pos}
            onChange={(event) => setPos(event.target.value)}
            type="number"
            min={0}
            title={t('detailPositionHint')}
            className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-[var(--beat-text-1)] outline-none focus:ring-2 focus:ring-[var(--beat-graph)]/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--beat-text-2)]">
            {t('detailDurationLabel')}
          </span>
          <input
            value={durationSec}
            onChange={(event) => setDurationSec(event.target.value)}
            type="number"
            min={0}
            step={0.1}
            className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-[var(--beat-text-1)] outline-none focus:ring-2 focus:ring-[var(--beat-graph)]/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--beat-text-2)]">
            {t('descriptionLabel')}
          </span>
          <textarea
            value={desc}
            onChange={(event) => setDesc(event.target.value)}
            rows={6}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] p-3 text-sm text-[var(--beat-text-1)] outline-none focus:ring-2 focus:ring-[var(--beat-graph)]/50"
          />
        </label>
      </div>
      <div className="border-t border-white/[0.07] p-3">
        <button
          type="button"
          disabled={saving || deleting}
          onClick={() => void handleSave()}
          className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[var(--beat-graph)]/20 text-sm font-medium text-[var(--beat-graph)] transition hover:bg-[var(--beat-graph)]/30 disabled:opacity-40"
        >
          {saving ? t('savingShot') : t('saveShot')}
        </button>
        <button
          type="button"
          disabled={saving || deleting}
          onClick={() => void handleDelete()}
          className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-red-400/25 text-sm font-medium text-red-300 transition hover:bg-red-400/10 disabled:opacity-40"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {deleting ? t('deletingShot') : t('deleteShot')}
        </button>
      </div>
    </aside>
  );
}

export function StoryWorkspace({ projectId }: { projectId: string }) {
  return <StoryWorkspaceContent projectId={projectId} />;
}
