"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BaseEdge,
  Background,
  Controls,
  Edge,
  Handle,
  MiniMap,
  Node,
  Position,
  ReactFlow,
  ReactFlowInstance,
  useNodesState,
  useEdgesState,
  OnNodesChange,
  NodeChange,
  getBezierPath,
  useInternalNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Button } from "@/components/ui/button";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { useManualPing } from "./manual-ping-provider";
import type { NetworkHealthTarget, NetworkHealthSample, NetworkHealthEvent, HealthStatus } from "@/lib/network-health";

function formatLatency(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(1)} ms` : "-";
}

export type ReachabilityMapProps = {
  targets: NetworkHealthTarget[];
  samples: NetworkHealthSample[];
  events: NetworkHealthEvent[];
  runnerId?: string;
};

type RunnerNodeData = { runner: { id: string; display_name: string; health_status: string; last_seen_at: string } };
type TargetNodeData = { target: NetworkHealthTarget };
type MonitoringEdgeData = {
  status: HealthStatus;
  activityKind?: "icmp";
  lastCheckedAt?: string;
  manualPingActivityToken?: number;
};

function getStrokeColorClass(status: HealthStatus): string {
  switch (status) {
    case "online": return "text-severity-low";
    case "degraded": return "text-severity-medium";
    default: return "text-severity-critical";
  }
}

function getStrokeWidth(status: HealthStatus): number {
  return status === "online" ? 2 : 1.5;
}

function getStrokeDashArray(status: HealthStatus): string {
  return status === "online" ? "0" : "6,4";
}

function RunnerNode({ data }: { data: RunnerNodeData }) {
  const { t } = useTranslation("dashboard");
  const { runner } = data;
  const isOnline = runner.health_status === "online";

  return (
    <div className="relative min-w-[200px]" style={{ transformOrigin: "center center" }}>
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" style={{ width: 8, height: 8 }} />
      <div className={`rounded-lg p-4 flex flex-col items-start gap-2 border-2 ${isOnline ? "border-severity-low bg-severity-low/10" : "border-severity-critical bg-severity-critical/10"}`}>
        <div className="w-3 h-3 rounded-full bg-current" />
        <div className="text-left w-full">
          <p className="font-medium text-text-primary whitespace-nowrap truncate">{runner.display_name}</p>
          <p className="text-xs text-text-secondary">{t("map.localRunner")}</p>
          <p className="text-xs text-text-muted">{t("map.source")}</p>
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-severity-low" : "bg-severity-critical"}`} />
          <span className="text-xs font-medium text-text-secondary">{t(isOnline ? "common:status.online" : "common:status.offline")}</span>
        </div>
      </div>
    </div>
  );
}

function TargetNode({ data }: { data: TargetNodeData }) {
  const { t } = useTranslation("dashboard");
  const { target } = data;
  const manualPing = useManualPing();
  const pingState = manualPing.states[target.id];
  const latest = target.latest;
  const status = latest?.status ?? "offline";
  const isOnline = status === "online";
  const isDegraded = status === "degraded";

  const statusColor = isOnline
    ? "border-severity-low bg-severity-low/10 text-severity-low"
    : isDegraded
    ? "border-severity-medium bg-severity-medium/10 text-severity-medium"
    : "border-severity-critical bg-severity-critical/10 text-severity-critical";

  const statusLabel = t(`common:status.${status}`);
  const statusDotColor = isOnline ? "bg-severity-low" : isDegraded ? "bg-severity-medium" : "bg-severity-critical";
  const transientClass = pingState?.phase === "loading"
    ? "ring-2 ring-accent"
    : pingState?.phase === "success"
      ? "ring-2 ring-severity-low"
      : pingState?.phase === "error"
        ? "ring-2 ring-severity-critical"
        : "";

  return (
    <div className="relative" style={{ width: 260, transformOrigin: "center center" }}>
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" style={{ width: 8, height: 8 }} />
      <div className={`rounded-panel border bg-bg-surface p-3 ${statusColor} ${transientClass}`}>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{target.node.name}</p>
          <p className="text-xs font-data text-text-secondary truncate">{target.node.ip_address}</p>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${statusColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${statusDotColor}`} />
            {statusLabel}
          </span>
          {latest && latest.latency_ms !== null && (
            <span className="font-data text-text-secondary text-xs">{latest.latency_ms.toFixed(1)} ms</span>
          )}
        </div>
        {manualPing.isAdmin ? (
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              className="nodrag nopan px-3 py-1.5 text-meta"
              disabled={!target.manual_ping_available || pingState?.phase === "loading"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                manualPing.run(target.id);
              }}
            >
              {t(pingState?.phase === "loading" ? "map.pinging" : "map.ping")}
            </Button>
            {!target.manual_ping_available ? (
              <span className="text-meta text-text-muted">{t("map.pingUnavailable")}</span>
            ) : pingState ? (
              <span className={`inline-flex min-w-0 items-center gap-2 text-meta ${
                pingState.phase === "error" ? "text-severity-critical" : pingState.phase === "success" ? "text-severity-low" : "text-accent"
              }`}>
                <span className={pingState.phase === "loading" ? "animate-pulse" : ""}>●</span>
                <span className="truncate font-data">{pingState.message}</span>
              </span>
            ) : <span className="text-meta text-text-muted">{t("map.oneShot")}</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type InternalMapNode = NonNullable<ReturnType<typeof useInternalNode>>;

function nodeDimensions(node: InternalMapNode) {
  return {
    width: node.measured.width ?? node.width ?? 1,
    height: node.measured.height ?? node.height ?? 1,
  };
}

function getNodeIntersection(intersectionNode: InternalMapNode, otherNode: InternalMapNode) {
  const intersection = nodeDimensions(intersectionNode);
  const other = nodeDimensions(otherNode);
  const position = intersectionNode.internals.positionAbsolute;
  const otherPosition = otherNode.internals.positionAbsolute;
  const center = { x: position.x + intersection.width / 2, y: position.y + intersection.height / 2 };
  const otherCenter = { x: otherPosition.x + other.width / 2, y: otherPosition.y + other.height / 2 };
  const dx = otherCenter.x - center.x;
  const dy = otherCenter.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const horizontalScale = dx === 0 ? Number.POSITIVE_INFINITY : intersection.width / 2 / Math.abs(dx);
  const verticalScale = dy === 0 ? Number.POSITIVE_INFINITY : intersection.height / 2 / Math.abs(dy);
  const scale = Math.min(horizontalScale, verticalScale);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function getEdgePosition(node: InternalMapNode, intersection: { x: number; y: number }) {
  const { width, height } = nodeDimensions(node);
  const position = node.internals.positionAbsolute;
  const distances = [
    { position: Position.Left, distance: Math.abs(intersection.x - position.x) },
    { position: Position.Right, distance: Math.abs(intersection.x - (position.x + width)) },
    { position: Position.Top, distance: Math.abs(intersection.y - position.y) },
    { position: Position.Bottom, distance: Math.abs(intersection.y - (position.y + height)) },
  ];
  return distances.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest).position;
}

function getEdgeParams(source: InternalMapNode, target: InternalMapNode) {
  const sourceIntersection = getNodeIntersection(source, target);
  const targetIntersection = getNodeIntersection(target, source);
  return {
    sx: sourceIntersection.x,
    sy: sourceIntersection.y,
    tx: targetIntersection.x,
    ty: targetIntersection.y,
    sourcePos: getEdgePosition(source, sourceIntersection),
    targetPos: getEdgePosition(target, targetIntersection),
  };
}

function MonitoringEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  style = {},
  markerEnd,
}: {
  id: string;
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  sourcePosition?: Position;
  targetX: number;
  targetY: number;
  targetPosition?: Position;
  data?: MonitoringEdgeData;
  style?: React.CSSProperties;
  markerEnd?: string;
}) {
  const sourceInternal = useInternalNode(source);
  const targetInternal = useInternalNode(target);

  const getInitialPrefersReducedMotion = () => {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    return false;
  };

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    getInitialPrefersReducedMotion,
  );

  /*
   * activityRun adalah trigger animation.
   *
   * Setiap Health Watch update atau manual PING akan menaikkan counter.
   * Efek animation kemudian di-restart dari awal.
   */
  const [activityRun, setActivityRun] = useState(0);

  const lastCheckedRef = useRef<string | undefined>(data?.lastCheckedAt);
  const manualActivityRef = useRef(data?.manualPingActivityToken ?? 0);

  /*
   * Dua SVG refs:
   *
   * motionPathRef
   * = path tersembunyi yang dipakai untuk menghitung titik sepanjang edge.
   *
   * activityGlyphRef
   * = icon ping yang benar-benar dipindahkan setiap animation frame.
   */
  const motionPathRef = useRef<SVGPathElement | null>(null);
  const activityGlyphRef = useRef<SVGGElement | null>(null);

  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );

    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener("change", handler);

    return () => {
      mediaQuery.removeEventListener("change", handler);
    };
  }, []);

  const {
    status,
    activityKind,
    lastCheckedAt,
    manualPingActivityToken = 0,
  } = data ?? {};

  /*
   * Satu event health/manual ping = satu animation run.
   *
   * Tidak pakai setInterval.
   * Tidak bergantung pada latency hasil ping.
   */
  const triggerActivity = useCallback(() => {
    setActivityRun((current) => current + 1);
  }, []);

  /*
   * Scheduled Health Watch activity.
   *
   * lastCheckedRef diinisialisasi dari data awal sehingga dashboard hydration
   * TIDAK membuat semua edge animate sekaligus.
   */
  useEffect(() => {
    if (!lastCheckedAt) {
      return;
    }

    if (lastCheckedAt === lastCheckedRef.current) {
      return;
    }

    lastCheckedRef.current = lastCheckedAt;
    triggerActivity();
  }, [lastCheckedAt, triggerActivity]);

  /*
   * Manual PING activity.
   *
   * Token dinaikkan oleh ReachabilityMap ketika admin klik PING.
   */
  useEffect(() => {
    if (manualPingActivityToken === manualActivityRef.current) {
      return;
    }

    manualActivityRef.current = manualPingActivityToken;
    triggerActivity();
  }, [manualPingActivityToken, triggerActivity]);

  const strokeColorClass = getStrokeColorClass(status ?? "offline");
  const strokeWidth = getStrokeWidth(status ?? "offline");
  const strokeDashArray = getStrokeDashArray(status ?? "offline");

  /*
   * Default/fallback geometry berasal dari React Flow.
   * Kalau actual internal node tersedia, gunakan floating geometry kita.
   */
  let sx = sourceX;
  let sy = sourceY;
  let tx = targetX;
  let ty = targetY;

  let sourcePos = sourcePosition ?? Position.Right;
  let targetPos = targetPosition ?? Position.Left;

  if (sourceInternal && targetInternal) {
    ({
      sx,
      sy,
      tx,
      ty,
      sourcePos,
      targetPos,
    } = getEdgeParams(sourceInternal, targetInternal));
  }

  /*
   * SATU canonical path.
   *
   * Path ini dipakai oleh:
   * - BaseEdge
   * - hidden motion path
   * - animated ICMP glyph
   */
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });

  /*
   * Smooth ICMP activity animation.
   *
   * Tidak memakai SVG <animateMotion>.
   *
   * Browser akan memindahkan glyph berdasarkan point sepanjang SVG path
   * pada setiap requestAnimationFrame.
   */
  useEffect(() => {
    const glyph = activityGlyphRef.current;
    const motionPath = motionPathRef.current;

    /*
     * Selalu mulai dari kondisi tidak terlihat.
     */
    if (glyph) {
      glyph.style.opacity = "0";
    }

    if (
      activityRun === 0 ||
      prefersReducedMotion ||
      activityKind !== "icmp" ||
      !glyph ||
      !motionPath
    ) {
      return;
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    let totalLength: number;

    try {
      totalLength = motionPath.getTotalLength();
    } catch {
      return;
    }

    if (!Number.isFinite(totalLength) || totalLength <= 0) {
      return;
    }

    /*
     * 2.2 detik cukup lambat agar aktivitas terlihat,
     * tapi tidak terasa seperti animasi dekoratif.
     */
    const durationMs = 2200;

    let startedAt: number | null = null;

    glyph.style.opacity = "1";

    const animate = (timestamp: number) => {
      if (startedAt === null) {
        startedAt = timestamp;
      }

      const elapsed = timestamp - startedAt;

      const progress = Math.min(
        Math.max(elapsed / durationMs, 0),
        1,
      );

      /*
       * Linear progress lebih jujur untuk activity indicator.
       * Tidak memberi kesan packet mempercepat/memperlambat karena latency.
       */
      const distance = totalLength * progress;

      const point = motionPath.getPointAtLength(distance);

      glyph.setAttribute(
        "transform",
        `translate(${point.x} ${point.y})`,
      );

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      /*
       * Setelah sampai target, icon hilang.
       * Base edge tetap terlihat.
       */
      glyph.style.opacity = "0";
      animationFrameRef.current = null;
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      glyph.style.opacity = "0";
    };
  }, [
    activityRun,
    activityKind,
    path,
    prefersReducedMotion,
  ]);

  return (
    <g
      className={strokeColorClass}
      data-monitoring-edge={id}
      data-edge-path={path}
    >
      {/* Persistent monitoring relationship */}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: "currentColor",
          strokeWidth,
          strokeDasharray: strokeDashArray,
          strokeLinecap: "round",
        }}
      />

      {/*
       * Invisible copy of the same edge.
       *
       * Browser uses this only for:
       * getTotalLength()
       * getPointAtLength()
       *
       * It never appears visually.
       */}
      <path
        ref={motionPathRef}
        d={path}
        fill="none"
        stroke="none"
        pointerEvents="none"
        aria-hidden="true"
      />

      {/*
       * Animated ICMP activity glyph.
       *
       * Position is controlled entirely through requestAnimationFrame.
       * Initial opacity 0 prevents a dot appearing at SVG origin.
       */}
      {activityKind === "icmp" && !prefersReducedMotion && (
        <g
          ref={activityGlyphRef}
          className="text-accent"
          pointerEvents="none"
          opacity="0"
          data-icmp-activity="active"
        >
          {/* outer radar ring */}
          <circle
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.65"
          />

          {/* ICMP pulse core */}
          <circle
            r="3"
            fill="currentColor"
          />

          {/* tiny highlight so glyph remains visible on green edges */}
          <circle
            r="1"
            fill="white"
            opacity="0.9"
          />
        </g>
      )}
    </g>
  );
}
function buildReachabilityGraph(targets: NetworkHealthTarget[], runnerId?: string) {
  const runnerNode: Node = {
    id: `runner-${runnerId ?? "local"}`,
    type: "runner",
    position: { x: 400, y: 300 },
    data: { runner: { id: runnerId ?? "local", display_name: "Local Runner", health_status: "online", last_seen_at: new Date().toISOString() } },
    draggable: true,
    origin: [0.5, 0.5],
  };

  const targetNodes: Node[] = [];
  const edges: Edge[] = [];

  const nodeWidth = 260;
  const nodeHeight = 140;
  const minGap = 40;
  const firstRingRadius = 280;
  const ringSpacing = nodeHeight + minGap;

  targets.forEach((target, index) => {
    let ring = 0;
    let ringStart = 0;
    let ringCapacity = 0;

    while (true) {
      const radius = firstRingRadius + ring * ringSpacing;
      const circumference = 2 * Math.PI * radius;
      ringCapacity = Math.max(1, Math.floor(circumference / (nodeWidth + minGap)));
      if (index < ringStart + ringCapacity) break;
      ringStart += ringCapacity;
      ring++;
    }

    const positionInRing = index - ringStart;
    const angle = (positionInRing / ringCapacity) * 2 * Math.PI - Math.PI / 2;
    const radius = firstRingRadius + ring * ringSpacing;
    const x = 400 + radius * Math.cos(angle);
    const y = 300 + radius * Math.sin(angle);

    const targetNode: Node = {
      id: target.id,
      type: "target",
      position: { x, y },
      data: { target },
      draggable: true,
      origin: [0.5, 0.5],
    };
    targetNodes.push(targetNode);

    edges.push({
      id: `edge-${target.id}`,
      source: `runner-${runnerId ?? "local"}`,
      target: target.id,
      type: "monitoring",
      data: {
        status: target.latest?.status ?? "offline",
        activityKind: "icmp",
        lastCheckedAt: target.latest?.last_checked_at,
        manualPingActivityToken: 0,
      },
    });
  });

  return { nodes: [runnerNode, ...targetNodes], edges };
}

function layoutReachabilityGraph(nodes: Node[], edges: Edge[]) {
  return { nodes, edges };
}

export function ReachabilityMap({ targets, runnerId }: ReachabilityMapProps) {
  const { t, i18n } = useTranslation("dashboard");
  const initialState = useMemo(() => buildReachabilityGraph(targets, runnerId), [targets, runnerId]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialState.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialState.edges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [layout, setLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const { openDeviceProfile } = useDeviceProfile();
  const manualPing = useManualPing();
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(`reachability-map-layout:${runnerId ?? "local"}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLayout(parsed);
        setNodes((nds) => nds.map((node) => {
          const savedPos = parsed[node.id];
          if (savedPos) return { ...node, position: savedPos };
          return node;
        }));
      } catch {
      }
    }
    setLayoutLoaded(true);
  }, [runnerId, setNodes]);

  useEffect(() => {
    if (layoutLoaded || Object.keys(layout).length > 0) return;
    const initialLayout: Record<string, { x: number; y: number }> = {};
    initialState.nodes.forEach((node) => {
      initialLayout[node.id] = node.position;
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLayout(initialLayout);
  }, [initialState, layoutLoaded, layout]);

  const handleNodesChange: OnNodesChange<Node> = useCallback((changes: NodeChange<Node>[]) => {
    onNodesChange(changes);
    changes.forEach((change) => {
      if (change.type === "position" && change.position) {
        setLayout((prev) => ({ ...prev, [change.id]: change.position as { x: number; y: number } }));
      }
    });
  }, [onNodesChange]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const fitView = useCallback(() => {
    reactFlowInstance.current?.fitView({ padding: 0.1, duration: 300 });
  }, []);

  const resetLayout = useCallback(() => {
    const newState = buildReachabilityGraph(targets, runnerId);
    setNodes(newState.nodes);
    setEdges(newState.edges);
    setLayout({});
    localStorage.removeItem(`reachability-map-layout:${runnerId ?? "local"}`);
  }, [targets, runnerId, setNodes, setEdges]);

  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: Node) => {
    setLayout((prev) => ({ ...prev, [node.id]: node.position }));
    localStorage.setItem(`reachability-map-layout:${runnerId ?? "local"}`, JSON.stringify({ ...layout, [node.id]: node.position }));
  }, [layout, runnerId, setLayout]);

  const { nodes: laidOutNodes, edges: laidOutEdges } = useMemo(() => {
    const currentTargets = new Map(targets.map((target) => [target.id, target]));
    const derivedNodes = nodes.map((node) => node.type === "target" && currentTargets.has(node.id)
      ? { ...node, data: { target: currentTargets.get(node.id) } }
      : node);
    const derivedEdges = edges.map((edge) => {
      const target = currentTargets.get(edge.target);
      return target ? {
        ...edge,
        data: {
          ...edge.data,
          status: target.latest?.status ?? "offline",
          lastCheckedAt: target.latest?.last_checked_at,
          manualPingActivityToken: manualPing.activityTokens[edge.target] ?? 0,
        },
      } : edge;
    });
    return layoutReachabilityGraph(derivedNodes, derivedEdges);
  }, [nodes, edges, manualPing.activityTokens, targets]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isFullscreen]);

  if (targets.length === 0) {
    return (
      <div className="mt-6 rounded-panel border border-border bg-bg-surface p-6 text-center">
        <p className="font-medium">{t("map.emptyTitle")}</p>
        <p className="mt-2 text-text-secondary">{t("map.emptyHelp")}</p>
      </div>
    );
  }

  return (
    <div className="mt-6 overflow-hidden rounded-panel border border-border bg-bg-surface" style={{ height: isFullscreen ? "100vh" : 680 }}>
      {!isFullscreen && (
        <div className="flex flex-col gap-6 border-b border-border px-5 py-4 md:px-6 md:py-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("map.eyebrow")}</p>
            <h2 className="mt-2 text-section font-semibold">{t("map.title")}</h2>
            <p className="mt-2 max-w-3xl text-text-secondary">{t("map.description")}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-4 lg:items-end">
            <div className="flex flex-col lg:items-end gap-1">
              <span className="text-meta text-text-secondary">{t("map.runner")}</span>
              <span className="font-data text-text-primary">{t("map.localRunner")}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={fitView}>{t("map.fit")}</Button>
              <Button variant="secondary" onClick={resetLayout}>{t("map.reset")}</Button>
              <Button onClick={() => setIsFullscreen(true)}>{t("map.expand")}</Button>
            </div>
          </div>
        </div>
      )}

      <div className="relative" style={{ width: "100%", height: isFullscreen ? "100vh" : "500px" }}>
        <ReactFlow
          nodes={laidOutNodes}
          edges={laidOutEdges}
          onInit={onInit}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={{ runner: RunnerNode, target: TargetNode }}
          edgeTypes={{ monitoring: MonitoringEdge }}
          fitView
          fitViewOptions={{ padding: 0.14 }}
          nodesConnectable={false}
          attributionPosition="bottom-right"
          minZoom={0.2}
          maxZoom={2}
          colorMode="dark"
        >
          <Background className="text-border" color="currentColor" gap={20} />
          <Controls />
          {isFullscreen && (
            <MiniMap
              className="bg-bg-base text-accent"
              nodeColor="currentColor"
            />
          )}
        </ReactFlow>

        {isFullscreen && (
          <div className="absolute top-4 right-4 z-10" role="button" tabIndex={0} aria-label={t("map.closeFullscreen")}>
            <Button
              variant="secondary"
              onClick={() => setIsFullscreen(false)}
              className="shadow-lg px-3 py-1.5 text-sm"
            >
              {t("map.close")}
            </Button>
          </div>
        )}
      </div>

      {selectedNode && (
        <div className={`fixed ${isFullscreen ? "z-50" : "z-50"} right-0 top-1/2 -translate-y-1/2 w-80 md:w-96 bg-bg-surface border-l border-border p-4 shadow-xl`} role="dialog" aria-modal="true">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <p className="text-meta uppercase tracking-wide text-accent">{t("map.nodeDetail")}</p>
              <h3 className="mt-1 text-heading font-semibold">
                {selectedNode.type === "runner" ? (selectedNode.data as { runner: { display_name: string } }).runner.display_name : (selectedNode.data as { target: NetworkHealthTarget }).target.node.name}
              </h3>
            </div>
            <button onClick={() => setSelectedNode(null)} className="text-text-muted hover:text-text-primary" aria-label={t("map.closeDetail")}>×</button>
          </div>
          <div className="space-y-3">
            {selectedNode.type === "target" && (() => {
              const target = (selectedNode.data as { target: NetworkHealthTarget }).target;
              const latest = target.latest;
              return (
                <>
                  <dl className="grid gap-2 sm:grid-cols-2 text-meta">
                    <div><dt className="text-text-secondary">IP</dt><dd className="font-data">{target.node.ip_address}</dd></div>
                    <div><dt className="text-text-secondary">{t("map.location")}</dt><dd>{target.node.location ?? "-"}</dd></div>
                    <div><dt className="text-text-secondary">{t("map.status")}</dt><dd>
                      <span className={latest?.status === "online" ? "text-severity-low" : latest?.status === "degraded" ? "text-severity-medium" : "text-severity-critical"}>
                        ● {t(`common:status.${latest?.status ?? "offline"}`)}
                      </span>
                    </dd></div>
                    <div><dt className="text-text-secondary">{t("map.latency")}</dt><dd className="font-data">{formatLatency(latest?.latency_ms)}</dd></div>
                    <div><dt className="text-text-secondary">{t("map.packetLoss")}</dt><dd className="font-data">{latest ? `${Number(latest.packet_loss_percent).toFixed(1)}%` : "-"}</dd></div>
                    <div><dt className="text-text-secondary">{t("map.lastChecked")}</dt><dd>{latest ? new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "id-ID", { dateStyle: "short", timeStyle: "medium" }).format(new Date(latest.last_checked_at)) : "-"}</dd></div>
                    <div><dt className="text-text-secondary">{t("map.monitoringState")}</dt><dd>{t(target.enabled ? "map.active" : "map.paused")}</dd></div>
                  </dl>
                  <Button variant="secondary" className="w-full" onClick={() => openDeviceProfile({ ipAddress: target.node.ip_address, runnerId: target.runner_id, observedStatus: latest?.status ?? "unknown" })}>
                    {t("map.openProfile")}
                  </Button>
                </>
              );
            })()}
            {selectedNode.type === "runner" && (
              <div className="space-y-2">
                <p className="text-meta text-text-secondary">{t("map.runnerHelp")}</p>
                <p className="text-sm text-text-muted">{t("map.clickHelp")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
