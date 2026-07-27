/** Retain the useful route while excluding OAuth codes, emails, and provider query details. */
export function requestPath(url: string | undefined): string {
  return (url ?? '').split('?', 1)[0];
}
