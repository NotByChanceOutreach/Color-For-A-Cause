/**
 * The server's text cleaning, for the forms. The rules live in ./textCore.ts, which is a byte-for-byte copy of
 * functions/src/textCore.ts (tests/functions/textCore.test.ts fails if the copies differ), so the forms judge a name
 * exactly the way the server will: the server refuses a name with nothing readable left once invisible and blank
 * characters are gone, and the forms catch that first.
 */
import { dropLoneSurrogates, hasReadableText, scrubText } from "./textCore";

export { hasReadableText };

/** The server's cleaning, trimmed. Never throws (the server refuses lone surrogates; here they are dropped). */
export function cleanText(value: string, multiline = false): string {
  return scrubText(dropLoneSurrogates(value), multiline, true);
}

/** The cleaned name when it has something readable in it, else null (send as Anonymous, or ask again). */
export function readableName(value: string): string | null {
  const name = cleanText(value);
  return hasReadableText(name) ? name : null;
}
