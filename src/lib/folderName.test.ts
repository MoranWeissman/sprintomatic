import { describe, it, expect } from 'vitest';
import { folderName } from './folderName';

describe('folderName', () => {
  it('keeps only the last folder', () => {
    expect(folderName('/home/someone/work/100001-feature')).toBe('100001-feature');
  });
  it('ignores a trailing slash and Windows slashes', () => {
    expect(folderName('/a/b/c/')).toBe('c');
    expect(folderName('C:\\a\\b')).toBe('b');
  });
  it('gives back the input when there is nothing to split', () => {
    expect(folderName('')).toBe('');
    expect(folderName('/')).toBe('/');
  });
});
