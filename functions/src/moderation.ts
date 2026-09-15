const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/;
const URL = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;
const HANDLE = /(^|\s)@[a-zA-Z0-9_]{3,}/;
const ADDRESSY =
  /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd)\b/i;

const BLOCK = ["kill yourself", "kys", "nazi", "rape", "porn", "child porn", "bomb threat"];

export function flagSubmission(text: string): string[] {
  const flags: string[] = [];
  const sample = text || "";
  if (EMAIL.test(sample)) flags.push("possible_email");
  if (PHONE.test(sample)) flags.push("possible_phone");
  if (URL.test(sample)) flags.push("possible_url");
  if (HANDLE.test(sample)) flags.push("possible_social_handle");
  if (ADDRESSY.test(sample)) flags.push("possible_address");
  const lower = sample.toLowerCase();
  for (const term of BLOCK) {
    if (lower.includes(term)) flags.push("possible_harmful_language");
  }
  return [...new Set(flags)];
}
