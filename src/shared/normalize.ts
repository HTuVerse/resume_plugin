export function normalize(value: string): string {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}
