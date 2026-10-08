// server/discovery-images.ts
/**
 * Board descriptions embed images as Azure DevOps attachments:
 *   ![alt](https://dev.azure.com/org/proj/_apis/wit/attachments/<guid>?fileName=image.png)
 * That URL needs the user's ADO credentials, so a browser <img> can't load it.
 *
 * We download each attachment once into the feature's own workspace folder
 * (discovery/images/) and rewrite the description to point at a local route the
 * dashboard CAN load. Next view it's already on disk — instant, and it survives
 * ADO being down. Pure parse/rewrite here; the fs + network live in the route.
 */
import { join } from 'node:path';

/** Only Azure DevOps work-item attachments — the case that needs auth. */
const ADO_ATTACHMENT = /_apis\/wit\/attachments\//i;

export interface DiscoveryImage {
  /** Original ADO attachment URL. */
  url: string;
  /** Stable local filename, derived from the attachment guid + extension. */
  localName: string;
}

/** Pull the attachment guid out of an ADO attachment URL, or null if not one. */
function attachmentId(url: string): string | null {
  const m = url.match(/_apis\/wit\/attachments\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/** File extension from the ?fileName= param (default png), sanitised. */
function extensionOf(url: string): string {
  const m = url.match(/[?&]fileName=[^&]*\.([a-z0-9]+)/i);
  const ext = (m ? m[1] : 'png').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'png';
}

/** Find every downloadable ADO image in the text, deduped by local name. */
export function extractImages(text: string): DiscoveryImage[] {
  const out = new Map<string, DiscoveryImage>();
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = m[1];
    const id = attachmentId(url);
    if (!id || !ADO_ATTACHMENT.test(url)) continue;
    const localName = `${id}.${extensionOf(url)}`;
    if (!out.has(localName)) out.set(localName, { url, localName });
  }
  return [...out.values()];
}

/** Rewrite ADO attachment URLs to the local serve route for this feature. */
export function rewriteImageUrls(text: string, featureId: number): string {
  return text.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (whole, open, url, close) => {
    const id = attachmentId(url);
    if (!id || !ADO_ATTACHMENT.test(url)) return whole;
    return `${open}/api/discovery/${featureId}/image/${id}.${extensionOf(url)}${close}`;
  });
}

/** Absolute path where a feature's cached images live. */
export function imagesDir(folderPath: string): string {
  return join(folderPath, 'discovery', 'images');
}

/** Guard: a served image name must be a bare `<guid>.<ext>`, no path tricks. */
export function isSafeImageName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}
