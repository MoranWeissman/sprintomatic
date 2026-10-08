import { describe, it, expect } from 'vitest';
import { extractImages, rewriteImageUrls, isSafeImageName } from './discovery-images';

const ADO = 'https://dev.azure.com/my-org/proj/_apis/wit/attachments/37c7d272-1b6b-4386-b51a-c5fd9d7063d9?fileName=image.png';

describe('extractImages', () => {
  it('finds an ADO attachment and names it by guid + extension', () => {
    expect(extractImages(`before ![Diagram](${ADO}) after`)).toEqual([
      { url: ADO, localName: '37c7d272-1b6b-4386-b51a-c5fd9d7063d9.png' },
    ]);
  });

  it('ignores non-ADO images (nothing to auth, browser can load them)', () => {
    expect(extractImages('![x](https://example.com/pic.png)')).toEqual([]);
  });

  it('dedupes the same attachment referenced twice', () => {
    expect(extractImages(`![a](${ADO}) ... ![b](${ADO})`)).toHaveLength(1);
  });

  it('defaults to png when fileName has no usable extension', () => {
    const noExt = 'https://dev.azure.com/o/p/_apis/wit/attachments/abc-123';
    expect(extractImages(`![x](${noExt})`)[0].localName).toBe('abc-123.png');
  });
});

describe('rewriteImageUrls', () => {
  it('points ADO images at the local serve route, keeping alt text', () => {
    expect(rewriteImageUrls(`![Diagram](${ADO})`, 100901))
      .toBe('![Diagram](/api/discovery/100901/image/37c7d272-1b6b-4386-b51a-c5fd9d7063d9.png)');
  });

  it('leaves non-ADO images untouched', () => {
    const s = '![x](https://example.com/pic.png)';
    expect(rewriteImageUrls(s, 1)).toBe(s);
  });
});

describe('isSafeImageName', () => {
  it('accepts a bare guid.ext', () => {
    expect(isSafeImageName('37c7d272-1b6b.png')).toBe(true);
  });
  it('rejects path traversal', () => {
    expect(isSafeImageName('../../etc/passwd')).toBe(false);
    expect(isSafeImageName('a/b.png')).toBe(false);
  });
});
