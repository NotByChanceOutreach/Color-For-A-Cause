/**
 * Text cleaning core. This file exists twice, byte for byte: functions/src/textCore.ts (the server) and
 * src/lib/textCore.ts (the forms). tests/functions/textCore.test.ts fails if the two copies differ. It has no
 * imports, so both builds compile it unchanged. The same code does not mean the same answer everywhere: `\p{...}`
 * uses the engine's own Unicode tables (Node 22 has Unicode 16, a current browser may have 17), so for a character
 * newer than the server's tables the SERVER decides; the forms show its refusal next to the field (Submit.tsx,
 * GroupSubmit.tsx).
 *
 * scrubText repeats one cleaning pass until nothing changes any more (a fixed point). Every rule below is
 * therefore judged against the characters that are actually KEPT, and no joiner is ever left dangling at the end.
 * One pass:
 *   - line breaks normalized; tab and newline kept in multi-line text, turned into spaces otherwise;
 *   - control characters and U+FFFD REPLACEMENT CHARACTER (what a failed decode leaves: junk) removed;
 *   - blank-by-design characters (BLANK_CODE_POINTS) turned into spaces;
 *   - every Default_Ignorable_Code_Point, format character (Cf) and noncharacter removed, except where it is part
 *     of real text (only when `keepJoiners`):
 *       ZWJ inside an emoji sequence (after a pictograph, a skin tone or VS16, before a pictograph);
 *       ZWJ / ZWNJ between two letters of ONE script whose spelling uses joiners (JOINER_SCRIPTS, an allowlist):
 *       Persian "می\u200cنا", Hindi "क्\u200cष", Sinhala "ශ්\u200dරී", Bengali "র\u200d্যাব". Combining marks on either
 *       side are looked past (a mark never changes the decision), but a letter must follow: a joiner followed only
 *       by marks trails in effect and is removed. Everywhere else (Latin, Greek, Cyrillic, Hebrew, Thai, Ethiopic,
 *       Cherokee, Coptic, Lisu, CJK, Hangul, mixed scripts...) a joiner changes nothing a reader sees and only
 *       hides text, so it is removed;
 *       VS16 / VS15 on an emoji, VS16 in a keycap (1\ufe0f⃣), ideographic variation selectors after a Han character,
 *       Mongolian variation selectors after a Mongolian letter;
 *       tag characters only inside the three RGI subdivision flags (England, Scotland, Wales);
 *   - NFC (after stripping, so what is stored is NFC), then trimmed.
 */

/**
 * Blank by design: characters whose whole job is to look like nothing; treated as a space.
 * Every \p{So}, \p{Lo} or \p{Mn} code point whose Unicode 16.0 name contains BLANK or FILLER (U+115F, U+1160, U+2422,
 * U+2800, U+3164, U+FFA0, U+13441, U+13442, U+16FE4 KHITAN SMALL SCRIPT FILLER), plus U+303F IDEOGRAPHIC HALF FILL
 * SPACE, U+FFFC OBJECT REPLACEMENT CHARACTER (drawn with no ink and no width by common fonts) and the empty musical
 * noteheads U+1D157 and U+1D159. Derived offline from Python's unicodedata (Unicode 16.0); the derivation is
 * recorded in tests/functions/textCore.test.ts, which checks this list against it.
 */
export const BLANK_CODE_POINTS: readonly number[] = [
  0x115f, 0x1160, 0x2422, 0x2800, 0x303f, 0x3164, 0xffa0, 0xfffc, 0x13441, 0x13442, 0x16fe4, 0x1d157, 0x1d159,
];

const BLANK = new Set<number>(BLANK_CODE_POINTS);
const REPLACEMENT_CHARACTER = 0xfffd;
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Noncharacter_Code_Point}]/u;
const CONTROL = /\p{Cc}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /\p{Emoji_Modifier}/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const KEYCAP = /[#*]\ufe0f?\u20e3/u;
const IDEOGRAPH = /\p{Ideographic}/u;
const MONGOLIAN = /\p{Script=Mongolian}/u;
const READABLE = /[\p{L}\p{N}\p{So}]/u;

/**
 * The scripts in which ZWNJ / ZWJ between two letters is part of ordinary spelling (Unicode Core Specification):
 *   - cursive joining scripts, where a joiner selects or breaks a joining form: Arabic (Persian, Urdu, Kurdish,
 *     Pashto... ZWNJ is standard Persian orthography, e.g. the prefix "می\u200c"), Syriac and N'Ko (same joining model as
 *     Arabic), Mongolian (joiners select positional forms);
 *   - Brahmi-derived scripts with a virama, where ZWJ asks for a half form, a chillu or a ligature and ZWNJ
 *     suppresses a conjunct: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam,
 *     Sinhala (ZWJ in "ශ්\u200dරී" and the rakaransaya / yansaya forms).
 * Not Tibetan: its stacks are encoded with explicit subjoined letters, so a joiner changes nothing there.
 * Scripts left out lose a joiner at worst as a slightly different glyph, still readable; keeping one where it does
 * nothing would let it hide text ("n\u200cazi").
 */
const JOINER_SCRIPTS: readonly RegExp[] = [
  /\p{Script=Arabic}/u,
  /\p{Script=Syriac}/u,
  /\p{Script=Nko}/u,
  /\p{Script=Mongolian}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Bengali}/u,
  /\p{Script=Gurmukhi}/u,
  /\p{Script=Gujarati}/u,
  /\p{Script=Oriya}/u,
  /\p{Script=Tamil}/u,
  /\p{Script=Telugu}/u,
  /\p{Script=Kannada}/u,
  /\p{Script=Malayalam}/u,
  /\p{Script=Sinhala}/u,
];

/** The only emoji tag sequences in the RGI set: 🏴 + tag letters + CANCEL TAG. */
const TAG_FLAGS: readonly string[][] = ["gbeng", "gbsct", "gbwls"].map((code) => [
  "\u{1F3F4}",
  ...Array.from(code, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))),
  "\u{E007F}",
]);

/** Which JOINER_SCRIPTS entry a letter belongs to, or -1 (not a letter, or a script that does not use joiners). */
function joinerScript(ch: string): number {
  if (!LETTER.test(ch)) return -1;
  return JOINER_SCRIPTS.findIndex((re) => re.test(ch));
}

/** The last kept character that is not a combining mark, when it is a letter; "" otherwise. */
function letterBefore(kept: readonly string[]): string {
  for (let k = kept.length - 1; k >= 0; k--) {
    if (MARK.test(kept[k])) continue;
    return LETTER.test(kept[k]) ? kept[k] : "";
  }
  return "";
}

/** The first input character after position i that is not a combining mark, when it is a letter; "" otherwise. */
function letterAfter(chars: readonly string[], i: number): string {
  for (let k = i + 1; k < chars.length; k++) {
    if (MARK.test(chars[k])) continue;
    return LETTER.test(chars[k]) ? chars[k] : "";
  }
  return "";
}

/** A joiner at chars[i] sits between two letters of one script that uses joiners (marks looked past). */
function joinsLetters(kept: readonly string[], chars: readonly string[], i: number): boolean {
  const before = joinerScript(letterBefore(kept));
  return before >= 0 && before === joinerScript(letterAfter(chars, i));
}

/** `kept` holds the characters kept so far; chars[i] is the ignorable being judged (the fixed point re-judges it). */
function keepsIgnorable(cp: number, kept: readonly string[], chars: readonly string[], i: number): boolean {
  const prev = kept.length ? kept[kept.length - 1] : "";
  const next = chars[i + 1] ?? "";
  if (cp === 0x200d) {
    const emoji = (PICTOGRAPH.test(prev) || SKIN_TONE.test(prev) || prev === "\ufe0f") && PICTOGRAPH.test(next);
    return emoji || joinsLetters(kept, chars, i);
  }
  if (cp === 0x200c) return joinsLetters(kept, chars, i);
  if (cp === 0xfe0f) return PICTOGRAPH.test(prev) || (KEYCAP_BASE.test(prev) && next === "\u20e3");
  if (cp === 0xfe0e) return PICTOGRAPH.test(prev);
  if ((cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef)) return IDEOGRAPH.test(prev);
  if ((cp >= 0x180b && cp <= 0x180d) || cp === 0x180f) return MONGOLIAN.test(prev) && LETTER.test(prev);
  return false;
}

function tagFlagAt(chars: string[], i: number): string[] | null {
  for (const flag of TAG_FLAGS) {
    if (flag.every((c, k) => chars[i + k] === c)) return flag;
  }
  return null;
}

function scrubOnce(value: string, multiline: boolean, keepJoiners: boolean): string {
  const chars = Array.from(value.replace(/\r\n?|[\u2028\u2029]/g, "\n"));
  const kept: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0) ?? 0;
    const flag = keepJoiners && cp === 0x1f3f4 ? tagFlagAt(chars, i) : null;
    if (flag) {
      kept.push(...flag);
      i += flag.length - 1;
      continue;
    }
    let out: string | null;
    if (ch === "\n" || ch === "\t") out = multiline ? ch : " ";
    else if (CONTROL.test(ch) || cp === REPLACEMENT_CHARACTER) out = null;
    else if (BLANK.has(cp)) out = " ";
    else if (IGNORABLE.test(ch)) out = keepJoiners && keepsIgnorable(cp, kept, chars, i) ? ch : null;
    else out = ch;
    if (out !== null) kept.push(out);
  }
  return kept.join("").normalize("NFC").trim();
}

/** Cleaned (see the header), NFC, trimmed, repeated until it stops changing. Never throws. */
export function scrubText(value: string, multiline: boolean, keepJoiners: boolean): string {
  let current = value;
  // Every pass after the first can only remove characters, so this ends quickly; the bound is only a guard.
  for (let pass = 0; pass < 64; pass++) {
    const next = scrubOnce(current, multiline, keepJoiners);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * Has at least one letter, digit or symbol (emoji included) that is not blank by design, or a #/* keycap.
 * A name must; anything else is blank to a reader.
 */
export function hasReadableText(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (READABLE.test(ch) && !BLANK.has(cp) && cp !== REPLACEMENT_CHARACTER) return true;
  }
  return KEYCAP.test(value);
}

function isSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff;
}

/** A UTF-16 surrogate without its partner: not a character, and not valid UTF-8 once stored. */
export function hasLoneSurrogate(value: string): boolean {
  for (const ch of value) if (isSurrogate(ch.codePointAt(0) ?? 0)) return true;
  return false;
}

/** For text we must keep but never show: lone surrogates are dropped, not refused. */
export function dropLoneSurrogates(value: string): string {
  let out = "";
  for (const ch of value) if (!isSurrogate(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

/** Cut to at most `max` UTF-16 code units without splitting a character, then cleaned again (no dangling joiner). */
export function capText(value: string, max: number, multiline: boolean): string {
  let out = "";
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return scrubText(out, multiline, true);
}
