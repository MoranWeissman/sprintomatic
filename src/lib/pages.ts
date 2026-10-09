/**
 * The Discovery & Design page shows only the halves the user turned on in
 * Settings → Pages. One on → the page is named after it. Both off → there is
 * no page at all.
 */
export type DndFacet = 'overview' | 'discovery' | 'design';

export interface DndPage {
  label: string;
  /** What a feature holds, for "pick one to read its …". */
  reads: string;
  /** Tabs inside an open feature, in order. Overview is board data, always there. */
  facets: DndFacet[];
  /** The tab a feature opens on. */
  firstFacet: DndFacet;
}

export function dndPage(pages: { discovery: boolean; design: boolean }): DndPage | null {
  const { discovery, design } = pages;
  if (!discovery && !design) return null;
  const label = discovery && design ? 'Discovery & Design' : discovery ? 'Discovery' : 'Design';
  const reads = discovery && design ? 'discovery, design, and demo' : discovery ? 'discovery and demo' : 'design';
  const facets: DndFacet[] = ['overview'];
  if (discovery) facets.push('discovery');
  if (design) facets.push('design');
  return { label, reads, facets, firstFacet: discovery ? 'discovery' : 'design' };
}
