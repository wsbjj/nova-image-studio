'use client';

import { useEffect, useState } from 'react';

import { getBlob } from '@/lib/slice-db';

/**
 * 根据 blobKey 从 IndexedDB 加载 Blob 并创建 objectURL。
 * 自动在 blobKey 变更或组件卸载时 revoke 上一个 objectURL，避免内存泄漏。
 * 参考 SliceWorkspace.tsx 中 WorkspaceCard/AssetPickerItem 的 objectURL 管理模式。
 *
 * 用 { key, url } 记录 URL 对应的 blobKey，返回时比对 key，
 * 这样 blobKey 变更后旧 URL 自动失效返回 null，无需在 effect 体内同步 setState。
 */
export function useBlobUrl(blobKey: string | null | undefined): string | null {
  const [state, setState] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    if (!blobKey) return;

    let active = true;
    let created: string | null = null;

    void getBlob(blobKey).then((blob) => {
      if (!active || !blob) return;
      created = URL.createObjectURL(blob);
      setState({ key: blobKey, url: created });
    });

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [blobKey]);

  return state && state.key === blobKey ? state.url : null;
}
