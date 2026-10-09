import { describe, expect, it } from 'vitest';
import { dndPage } from './pages';

describe('dndPage', () => {
  it('is gone when both halves are off', () => {
    expect(dndPage({ discovery: false, design: false })).toBeNull();
  });

  it('is named after the one half that is on, and shows only it', () => {
    expect(dndPage({ discovery: false, design: true })).toEqual({
      label: 'Design', reads: 'design', facets: ['overview', 'design'], firstFacet: 'design',
    });
    expect(dndPage({ discovery: true, design: false })).toEqual({
      label: 'Discovery', reads: 'discovery and demo', facets: ['overview', 'discovery'], firstFacet: 'discovery',
    });
  });

  it('shows both and opens on Discovery when both are on', () => {
    expect(dndPage({ discovery: true, design: true })).toEqual({
      label: 'Discovery & Design', reads: 'discovery, design, and demo', facets: ['overview', 'discovery', 'design'], firstFacet: 'discovery',
    });
  });
});
