"use client";

import React, { useEffect, useRef, useState } from "react";

import { canvasTheme, type CanvasBackgroundMode } from "../lib/canvas-theme";
import type { CanvasInteractionMode, ViewportTransform } from "../types";

type InfiniteCanvasProps = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewport: ViewportTransform;
  interactionMode: CanvasInteractionMode;
  backgroundMode?: CanvasBackgroundMode;
  onViewportChange: (viewport: ViewportTransform) => void;
  onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onCanvasDeselect?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
};

/** 浮层选择器：滚轮缩放时跳过弹窗/菜单/下拉，避免与其滚动冲突。 */
const OVERLAY_SELECTOR = '[data-canvas-no-zoom],[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';

export function InfiniteCanvas({ containerRef, viewport, interactionMode, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
  const theme = canvasTheme;
  const panState = useRef({
    isPanning: false,
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,
    hasMoved: false,
  });
  const scaleRef = useRef(viewport.k);
  const frameRef = useRef<number | null>(null);
  const nextViewportRef = useRef<ViewportTransform | null>(null);
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  useEffect(() => {
    scaleRef.current = viewport.k;
  }, [viewport.k]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      setIsSpacePressed(true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setIsSpacePressed(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(OVERLAY_SELECTOR)) return;

    const delta = -event.deltaY;
    const factor = Math.pow(1.1, delta / 100);
    const newScale = Math.min(Math.max(viewport.k * factor, 0.05), 5);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const worldX = (mouseX - viewport.x) / viewport.k;
    const worldY = (mouseY - viewport.y) / viewport.k;

    onViewportChange({
      x: mouseX - worldX * newScale,
      y: mouseY - worldY * newScale,
      k: newScale,
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-canvas-no-zoom]")) return;
    if (target?.closest("[data-connection-create-menu]")) return;
    const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");

    const shouldPan = interactionMode === "pan" || isSpacePressed;

    if (isBackgroundClick && (event.button === 0 || event.button === 1) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (event.button === 0 && !shouldPan && isBackgroundClick) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      onCanvasMouseDown?.(event);
      return;
    }

    if (event.button === 1 || (event.button === 0 && shouldPan && isBackgroundClick)) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panState.current = {
        isPanning: true,
        startX: event.clientX,
        startY: event.clientY,
        initialX: viewport.x,
        initialY: viewport.y,
        hasMoved: false,
      };
      document.body.style.cursor = "grabbing";
      return;
    }

  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!panState.current.isPanning) return;

      const dx = event.clientX - panState.current.startX;
      const dy = event.clientY - panState.current.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        panState.current.hasMoved = true;
      }

      nextViewportRef.current = {
        x: panState.current.initialX + dx,
        y: panState.current.initialY + dy,
        k: scaleRef.current,
      };
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
      });
    };

    const handlePointerUp = () => {
      if (!panState.current.isPanning) return;

      if (!panState.current.hasMoved) {
        onCanvasDeselect?.();
      }
      panState.current.isPanning = false;
      document.body.style.cursor = "default";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onCanvasDeselect, onViewportChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const preventWheelScroll = (event: WheelEvent) => {
      // 滚轮在 [data-canvas-no-zoom] 内部时（如 textarea / contentEditable），不拦截，让其原生滚动。
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OVERLAY_SELECTOR)) return;
      event.preventDefault();
    };
    container.addEventListener("wheel", preventWheelScroll, { passive: false });
    return () => container.removeEventListener("wheel", preventWheelScroll);
  }, [containerRef]);

  return (
    <div
      ref={containerRef}
      data-canvas-mode={interactionMode}
      className={`relative h-full w-full select-none overflow-hidden ${interactionMode === "pan" || isSpacePressed ? "cursor-grab" : "cursor-crosshair"}`}
      style={{ background: theme.canvas.background }}
      onPointerDown={handlePointerDown}
      onWheel={handleWheel}
      onContextMenu={onContextMenu}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <CanvasGrid viewport={viewport} mode={backgroundMode} />
      <div
        className="absolute origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
  const theme = canvasTheme;
  if (mode === "blank") return null;

  const gridSize = 48 * viewport.k;
  const x = viewport.x % gridSize;
  const y = viewport.y % gridSize;
  const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
  const backgroundImage =
    mode === "dots"
      ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)`
      : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-40"
      style={{
        backgroundImage,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}
