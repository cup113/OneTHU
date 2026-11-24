/**
 * 「把资源管理器里的文件拖进这个区块」。
 *
 * Windows 上 Tauri 窗口默认开着自己的原生拖放（`dragDropEnabled`），文件在 WebView2
 * 外层就被接管了，网页里的 `drop` 拿不到 `dataTransfer.files`——所以窗口配置必须关掉它，
 * 拖放才回得到这里（见 apps/desktop/src-tauri/tauri.conf.json）。
 *
 * 监听按 capture 注册并 `stopPropagation`：落在本区块的文件归本区块，不再冒泡给
 * 暂存箱（整屏弹出「松开收进暂存箱」）或富文本编辑器（当正文插图吃进去）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useFileDrop(
  onFile: (file: File) => void,
  enabled = true,
): {
  /** 挂到接收区容器上（callback ref：区块晚于首次渲染出现时也能接上） */
  ref: (element: HTMLDivElement | null) => void;
  /** 是否有文件正悬在接收区上（用于高亮，不在平时占版面） */
  hot: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [hot, setHot] = useState(false);
  const latest = useRef(onFile);
  useEffect(() => {
    latest.current = onFile;
  }, [onFile]);

  useEffect(() => {
    if (!element || !enabled) {
      setHot(false);
      return;
    }
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth += 1;
      setHot(true);
      // 拖拽可能在别处（暂存箱）已经展开过接收层：进本区块就让它收起，
      // 免得「收进暂存箱」的整屏遮罩压在这里的文件上。
      window.dispatchEvent(new Event("onethu:vault-file-drop-handled"));
    };
    const over = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent): void => {
      event.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setHot(false);
    };
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setHot(false);
      const file = Array.from(event.dataTransfer?.files ?? [])[0];
      if (file) latest.current(file);
    };
    const reset = (): void => {
      depth = 0;
      setHot(false);
    };
    element.addEventListener("dragenter", enter, true);
    element.addEventListener("dragover", over, true);
    element.addEventListener("dragleave", leave, true);
    element.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      element.removeEventListener("dragenter", enter, true);
      element.removeEventListener("dragover", over, true);
      element.removeEventListener("dragleave", leave, true);
      element.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [element, enabled]);

  const ref = useCallback((node: HTMLDivElement | null): void => {
    setElement(node);
  }, []);

  return { ref, hot };
}
