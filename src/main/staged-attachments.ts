import path from 'node:path';

/** Attachment descriptor as it arrives over IPC from any composer mode. */
export type StagedRequestItem = { id?: string; assetId?: string; name?: string; mimeType?: string };

export type ResolvedStagedAttachment = {
  id?: string;
  assetId?: string;
  name: string;
  mimeType: string;
  path: string;
};

/**
 * Turns staged renderer attachments into real file paths.
 *
 * Every chat/image/video IPC handler goes through this, so a single rule decides
 * what the main process sees. A staged item that cannot be resolved is a hard
 * error: silently dropping it would send the prompt without the reference image
 * the user believes they attached.
 */
export function resolveStagedAttachments(
  items: StagedRequestItem[] = [],
  resolve: (assetId: string) => string,
  baseName: (file: string) => string = file => path.basename(file),
): ResolvedStagedAttachment[] {
  const missing: string[] = [];
  const resolved = items.flatMap(item => {
    const assetId = String(item.assetId ?? item.id ?? '');
    try {
      const file = resolve(assetId);
      return [{ ...item, path: file, name: item.name || baseName(file), mimeType: item.mimeType || 'application/octet-stream' }];
    } catch {
      missing.push(assetId || '(空 ID)');
      return [];
    }
  });
  if (missing.length) {
    throw new Error(`附件已失效，请重新添加：${[...new Set(missing)].join('、')}`);
  }
  return resolved;
}

/**
 * Account mode's draft images arrive as bare asset ids (no name/mime), so they
 * take the same resolver through a thin adapter. Order is preserved because the
 * page import re-uploads files one by one.
 */
export function resolveStagedAssetPaths(
  assetIds: string[] = [],
  resolve: (assetId: string) => string,
  baseName: (file: string) => string = file => path.basename(file),
): string[] {
  return resolveStagedAttachments(
    (Array.isArray(assetIds) ? assetIds : []).map(assetId => ({ assetId: String(assetId ?? '') })),
    resolve,
    baseName,
  ).map(item => item.path);
}
