export const ORG_HOME = "https://notbychanceoutreach.com/";

export function publicAttribution(opts: {
  kind: string;
  text: string;
  showAttribution: boolean;
  org?: string | null;
  showOrg?: boolean;
}): { byline: string; orgLine?: string } {
  const byline = !opts.showAttribution || opts.kind === "anonymous" || !opts.text.trim()
    ? "Artwork by Anonymous Artist"
    : `Artwork by ${opts.text.trim()}`;
  const orgLine =
    opts.showOrg && opts.org?.trim()
      ? `Created during an art activity at ${opts.org.trim()}`
      : undefined;
  return { byline, orgLine };
}
