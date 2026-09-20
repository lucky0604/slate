import { useEffect } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from '@xyflow/react';
import { Clapperboard, Plus } from 'lucide-react';

import { isCanvasShotCard, type CanvasShotCard } from '@/core/beatcanvas/canvas-types';
import type { ProjectSnapshotDocument } from '@/core/projects/project-snapshot';
import type { Shot } from '@/config/db/schema';
import { useTranslations } from '@/core/workspace-lib/shims/next-intl';

import '@xyflow/react/dist/style.css';
import '@/styles/react-flow-beatcanvas.css';

const SHOT_W = 236;
const SHOT_H = 148;

type ShotFlowNodeData = {
  shotId: string;
  description: string;
  durationLabel: string;
  shotNumberLabel: string;
  selected: boolean;
};

type ShotFlowNode = Node<ShotFlowNodeData, 'shot'>;

function ShotCardNode({ data }: NodeProps<ShotFlowNode>) {
  return (
    <div
      data-beatcard-kind="shot"
      className="flex h-full w-full cursor-pointer select-none flex-col overflow-hidden rounded-xl border bg-[var(--beat-surface-2)] transition"
      style={{
        width: SHOT_W,
        height: SHOT_H,
        borderColor: data.selected
          ? 'rgba(127, 176, 242, 0.9)'
          : 'rgba(255,255,255,0.09)',
        boxShadow: data.selected
          ? '0 0 0 2px rgba(127,176,242,0.35), 0 12px 32px rgba(0,0,0,0.4)'
          : '0 8px 24px rgba(0,0,0,0.3)',
      }}
    >
      <div className="flex items-center justify-between gap-1.5 px-3 pt-2.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--beat-graph)]">
          <Clapperboard className="size-3.5" aria-hidden="true" />
          <span>{data.shotNumberLabel}</span>
        </span>
        {data.durationLabel ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--beat-text-2)]">
            {data.durationLabel}
          </span>
        ) : null}
      </div>
      <p className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap px-3 pb-2.5 pt-1 text-[12px] leading-snug text-[var(--beat-text-1)]">
        {data.description}
      </p>
    </div>
  );
}

const nodeTypes = { shot: ShotCardNode };

function ShotCanvasInner({
  document,
  shots,
  selectedShotId,
  onSelectShot,
  onMoveShot,
  onAddShot,
}: {
  document: ProjectSnapshotDocument | null;
  shots: Shot[];
  selectedShotId: string | null;
  onSelectShot: (shotId: string) => void;
  onMoveShot: (
    cardId: string,
    frame: { x: number; y: number; w: number; h: number }
  ) => void;
  onAddShot: () => void;
}) {
  const t = useTranslations('StoryWorkspace');
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]));
  const [nodes, setNodes, onNodesChange] = useNodesState<ShotFlowNode>([]);

  // Re-derive nodes from the reconciled projection document + Domain shots
  // whenever either changes (scene switch, domain refresh).
  useEffect(() => {
    if (!document) {
      setNodes([]);
      return;
    }
    const collection: ShotFlowNode[] = document.cards
      .filter(isCanvasShotCard)
      .filter((card) => shotsById.has(card.shotId))
      .sort((a, b) => {
        const aIndex = shots.findIndex((shot) => shot.id === a.shotId);
        const bIndex = shots.findIndex((shot) => shot.id === b.shotId);
        return aIndex - bIndex;
      })
      .map((card: CanvasShotCard) => {
        const shot = shotsById.get(card.shotId);
        const frame = document.frames[card.id] ?? { x: 40, y: 40 };
        const index = shots.findIndex(
          (candidate) => candidate.id === card.shotId
        );
        return {
          id: card.id,
          type: 'shot' as const,
          position: { x: frame.x, y: frame.y },
          data: {
            shotId: card.shotId,
            shotNumberLabel: t('shotLabel', { number: index + 1 }),
            durationLabel:
              shot?.durationMs != null
                ? t('seconds', { value: (shot.durationMs / 1000).toFixed(1) })
                : '',
            description: shot?.description || t('noDescription'),
            selected: card.shotId === selectedShotId,
          },
          deletable: false,
        };
      });
    setNodes(collection);
  }, [document, shots, shotsById, selectedShotId, setNodes, t]);

  const onNodeClick: NodeMouseHandler<ShotFlowNode> = (event, node) => {
    event.stopPropagation();
    onSelectShot(node.data.shotId);
  };

  const onNodeDragStop = (
    _event: unknown,
    node: ShotFlowNode
  ) => {
    // Canvas layout only: persists x/y via canvas.apply, never shot.position.
    onMoveShot(node.id, { x: node.position.x, y: node.position.y, w: SHOT_W, h: SHOT_H });
  };

  const isEmpty =
    !document ||
    document.cards.filter((card) => isCanvasShotCard(card) && shotsById.has(card.shotId))
      .length === 0;

  return (
    <div className="relative h-full w-full">
      {isEmpty ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
            <p className="text-sm font-medium text-[var(--beat-text-1)]">
              {t('addFirstShot')}
            </p>
            <p className="mt-1 text-xs text-[var(--beat-text-2)]">
              {t('addShotEmptyDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={onAddShot}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--beat-graph)]/15 px-4 py-2 text-sm font-medium text-[var(--beat-graph)] transition hover:bg-[var(--beat-graph)]/25"
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('addShot')}
          </button>
        </div>
      ) : (
        <ReactFlow<ShotFlowNode>
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          nodesConnectable={false}
          minZoom={0.25}
          maxZoom={2.5}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgba(127, 176, 242, 0.18)"
          />
          <Controls />
          <MiniMap
            pannable
            zoomable
            nodeColor="rgba(127,176,242,0.55)"
            maskColor="rgba(10,10,11,0.7)"
          />
        </ReactFlow>
      )}
    </div>
  );
}

export function ShotCanvas(props: {
  document: ProjectSnapshotDocument | null;
  shots: Shot[];
  selectedShotId: string | null;
  onSelectShot: (shotId: string) => void;
  onMoveShot: (
    cardId: string,
    frame: { x: number; y: number; w: number; h: number }
  ) => void;
  onAddShot: () => void;
}) {
  return (
    <ReactFlowProvider>
      <ShotCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
