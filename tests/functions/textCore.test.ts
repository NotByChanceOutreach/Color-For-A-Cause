import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLANK_CODE_POINTS, scrubText } from "../../functions/src/textCore";
import { NAME_REQUIRED, cleanStoredText, cleanText, hasReadableText, parseSubmitRequest } from "../../functions/src/validation";
import { NAME_REQUIRED as CLIENT_NAME_REQUIRED } from "../../src/lib/refusals";
import { cleanText as clientCleanText, hasReadableText as clientHasReadableText, readableName } from "../../src/lib/text";
import { expectSyncCode, validSubmit } from "./fixtures";
import { CLEAN_VECTORS, NAME_VECTORS } from "./textVectors";

/**
 * Every Unicode 16.0 code point whose name contains the word BLANK or FILLER, derived offline with Python 3.14
 * (unicodedata.unidata_version == "16.0.0"):
 *
 *   for cp in range(0x110000):
 *       name = unicodedata.name(chr(cp), "")
 *       if {"BLANK", "FILLER"} & set(name.split()): print(hex(cp), unicodedata.category(chr(cp)), name)
 *
 * Letters, symbols and the one combining mark (Lo, So, Mn: U+16FE4 KHITAN SMALL SCRIPT FILLER) are blank by design and
 * must be treated as blank. The punctuation fillers (Po) are never counted as readable, so a name made only of them
 * is refused anyway.
 */
const UNICODE_BLANK_OR_FILLER: Array<[number, "Lo" | "So" | "Po" | "Mn", string]> = [
  [0x115f, "Lo", "HANGUL CHOSEONG FILLER"],
  [0x1160, "Lo", "HANGUL JUNGSEONG FILLER"],
  [0x2422, "So", "BLANK SYMBOL"],
  [0x2800, "So", "BRAILLE PATTERN BLANK"],
  [0x3164, "Lo", "HANGUL FILLER"],
  [0xa8f9, "Po", "DEVANAGARI GAP FILLER"],
  [0xffa0, "Lo", "HALFWIDTH HANGUL FILLER"],
  [0x10af6, "Po", "MANICHAEAN PUNCTUATION LINE FILLER"],
  [0x1144e, "Po", "NEWA GAP FILLER"],
  [0x11945, "Po", "DIVES AKURU GAP FILLER"],
  [0x11f48, "Po", "KAWI PUNCTUATION SPACE FILLER"],
  [0x13441, "Lo", "EGYPTIAN HIEROGLYPH FULL BLANK"],
  [0x13442, "Lo", "EGYPTIAN HIEROGLYPH HALF BLANK"],
  [0x16fe4, "Mn", "KHITAN SMALL SCRIPT FILLER"],
];
/** Blank by design although the name does not say BLANK or FILLER. */
const ALSO_BLANK = [
  0x303f, // IDEOGRAPHIC HALF FILL SPACE
  0xfffc, // OBJECT REPLACEMENT CHARACTER: zero ink and zero advance in Segoe UI (round-3 canvas check)
  0x1d157, // MUSICAL SYMBOL VOID NOTEHEAD
  0x1d159, // MUSICAL SYMBOL NULL NOTEHEAD
];

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase()}`;

describe("text cleaning: one implementation for the server and the forms", () => {
  it("the forms know the server's name refusal word for word (they show it at the name field)", () => {
    expect(CLIENT_NAME_REQUIRED).toBe(NAME_REQUIRED);
  });

  it("functions/src/textCore.ts and src/lib/textCore.ts are the very same file", () => {
    expect(readFileSync("src/lib/textCore.ts", "utf8")).toBe(readFileSync("functions/src/textCore.ts", "utf8"));
  });

  it("the core has no imports, so both builds compile it unchanged", () => {
    expect(readFileSync("functions/src/textCore.ts", "utf8")).not.toMatch(/^\s*import\s/m);
  });

  it.each(CLEAN_VECTORS)("%s", (_what, input, expected) => {
    expect(cleanText(input, false)).toBe(expected);
    expect(cleanText(input, true)).toBe(expected);
    expect(cleanStoredText(input, false)).toBe(expected);
    expect(clientCleanText(input)).toBe(expected);
    expect(clientCleanText(input, true)).toBe(expected);
    // A fixed point: cleaning clean text changes nothing.
    expect(cleanText(expected, false)).toBe(expected);
  });

  it.each(NAME_VECTORS.map(([s, ok]) => [JSON.stringify(s), s, ok] as const))("name %s readable: %s", (_label, name, readable) => {
    expect(hasReadableText(cleanText(name, false))).toBe(readable);
    expect(clientHasReadableText(clientCleanText(name))).toBe(readable);
    expect(readableName(name) !== null).toBe(readable);
    if (readable) {
      expect(parseSubmitRequest(validSubmit({ attributionKind: "nickname", attributionText: name })).attributionText).toBe(cleanText(name, false));
    } else {
      const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: name })), "invalid-argument");
      expect(err.message).toBe(NAME_REQUIRED);
    }
  });
});

describe("text cleaning: blank by design (derived from the Unicode names)", () => {
  it("the recorded derivation still matches this engine's Unicode data", () => {
    for (const [cp, category] of UNICODE_BLANK_OR_FILLER) {
      expect(new RegExp(String.raw`\p{` + category + "}", "u").test(String.fromCodePoint(cp)), hex(cp)).toBe(true);
    }
  });

  it("BLANK_CODE_POINTS is exactly every Lo/So/Mn entry of the derivation plus the documented extras", () => {
    const expected = [...UNICODE_BLANK_OR_FILLER.filter(([, c]) => c !== "Po").map(([cp]) => cp), ...ALSO_BLANK];
    expect([...BLANK_CODE_POINTS].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });

  it.each([...BLANK_CODE_POINTS].map((cp) => [hex(cp), cp]))("%s is a space, never a readable name", (_name, cp) => {
    const ch = String.fromCodePoint(cp as number);
    expect(cleanText(`Sky${ch}`, false)).toBe("Sky");
    expect(cleanText(`${ch}Sky`, false)).toBe("Sky");
    expect(cleanText(`S${ch}ky`, false)).toBe("S ky");
    expect(clientCleanText(`S${ch}ky`)).toBe("S ky");
    expect(hasReadableText(ch)).toBe(false);
    expect(readableName(ch + ch)).toBeNull();
    const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: ch + ch })), "invalid-argument");
    expect(err.message).toBe(NAME_REQUIRED);
  });

  it.each(UNICODE_BLANK_OR_FILLER.filter(([, c]) => c === "Po").map(([cp, , n]) => [n, cp]))(
    "%s is not readable",
    (_name, cp) => {
      const ch = String.fromCodePoint(cp as number);
      expect(hasReadableText(cleanText(ch + ch, false))).toBe(false);
      expect(readableName(ch + ch)).toBeNull();
    },
  );

  it("U+FFFD (a failed decode) is junk: removed, not a space, never readable", () => {
    expect(cleanText("Sk\u{fffd}y", false)).toBe("Sky");
    expect(hasReadableText("\u{fffd}")).toBe(false);
    expect(readableName("\u{fffd}")).toBeNull();
  });
});

describe("text cleaning: a fixed point, judged against the characters that are kept", () => {
  /** Deterministic xorshift, so a failure can be replayed. */
  function rng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 0x100000000;
    };
  }
  const ALPHABET = [
    "a", "S", " ", "\u{0645}", "\u{06cc}", "\u{0915}", "\u{094d}", "\u{0dc1}", "\u{0dca}", "\u{0d4d}", "\u{845b}", "\u{1820}",
    "\u{200b}", "\u{200c}", "\u{200d}", "\u{2060}", "\u{034f}", "\u{00ad}", "\u{fe00}", "\u{fe0e}", "\u{fe0f}", "\u{e0100}",
    "\u{180b}", "\u{20e3}", "#", "1", "\u{1f469}", "\u{1f3a8}", "\u{1f3f4}", "\u{e0067}", "\u{e0062}", "\u{e0065}", "\u{e006e}",
    "\u{e007f}", "\u{e0041}", "\u{3164}", "\u{115f}", "\u{2800}", "\u{fffc}", "\u{fffd}", "\u{13441}", "\u{202e}", "\u{0301}",
    "\n", "\t", "\u{2028}",
    // Round 4: scripts that do not use joiners, marks around a joiner, the Khitan filler.
    "\u{05e9}", "\u{13da}", "\u{0e01}", "\u{0f40}", "\u{0710}", "\u{09b0}", "\u{09cd}", "\u{064b}", "\u{0332}", "\u{16fe4}",
  ];
  /** A joiner at the start, or one followed by nothing but combining marks (it trails in effect). */
  const JOINERS_AT_EDGE = /^[\u{200c}\u{200d}\u{fe0e}\u{fe0f}\u{180b}-\u{180f}\u{e0100}-\u{e01ef}]|[\u{200c}\u{200d}]\p{M}*$/u;
  const JOINER_SCRIPTS = ["Arabic", "Syriac", "Nko", "Mongolian", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala"];
  const SCRIPT_RES = JOINER_SCRIPTS.map((name) => new RegExp(`^\\p{Script=${name}}$`, "u"));
  const scriptOf = (ch: string | undefined) => (ch !== undefined && /^\p{L}$/u.test(ch) ? SCRIPT_RES.findIndex((re) => re.test(ch)) : -1);
  /** Every ZWJ / ZWNJ left sits in an emoji sequence, or between two letters of ONE allowlisted script (marks looked past). */
  function joinersJustified(text: string): boolean {
    const cs = Array.from(text);
    for (let i = 0; i < cs.length; i++) {
      if (cs[i] !== "\u{200c}" && cs[i] !== "\u{200d}") continue;
      const emoji = cs[i] === "\u{200d}" && /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}]/u.test(cs[i - 1] ?? "") && /\p{Extended_Pictographic}/u.test(cs[i + 1] ?? "");
      if (emoji) continue;
      let a = i - 1;
      while (a >= 0 && /\p{M}/u.test(cs[a])) a--;
      let b = i + 1;
      while (b < cs.length && /\p{M}/u.test(cs[b])) b++;
      const before = scriptOf(cs[a]);
      if (before < 0 || before !== scriptOf(cs[b])) return false;
    }
    return true;
  }

  it("never leaves a joiner at either end, is idempotent, and the forms agree with the server (3000 random strings)", () => {
    const next = rng(20260915);
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(next() * 10);
      let s = "";
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      for (const multiline of [false, true]) {
        const server = cleanText(s, multiline);
        expect(clientCleanText(s, multiline), JSON.stringify(s)).toBe(server);
        expect(scrubText(server, multiline, true), JSON.stringify(s)).toBe(server);
        expect(JOINERS_AT_EDGE.test(server), JSON.stringify([s, server])).toBe(false);
        expect(joinersJustified(server), JSON.stringify([s, server])).toBe(true);
      }
    }
  });
});
