/** The last part of a folder path: '/a/b/my-feature/' → 'my-feature'. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
