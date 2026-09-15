import { describe, expect, it } from "vitest";
import {
  CONSENT_VERSION as SERVER_CONSENT_VERSION,
  PAGE_IDS,
  PERMISSION_KEYS,
  PUBLIC_STATUSES as SERVER_PUBLIC_STATUSES,
} from "../../functions/src/constants";
import { artistKey, publicGalleryDoc } from "../../functions/src/moderate";
import { flagSubmission } from "../../functions/src/moderation";
import {
  COLLECTIBLE_FIELDS as SERVER_COLLECTIBLE_FIELDS,
  NAME_REQUIRED,
  bylineKey,
  cleanText,
  hasReadableText,
  parseCollectibleRequest,
  parseCreateGroupRequest,
  parseFinalizeRequest,
  parseGetGroupRequest,
  parseModerateRequest,
  parseSubmitRequest,
} from "../../functions/src/validation";
import { CONSENT_VERSION, emptyPermissions } from "../../src/data/consent";
import { PAGES } from "../../src/data/pages";
import { COLLECTIBLE_FIELDS, collectiblePayload } from "../../src/lib/collectibles";
import { cleanText as clientCleanText, hasReadableText as clientHasReadableText } from "../../src/lib/text";
import { PUBLIC_STATUSES, type Collectible } from "../../src/types";
import { expectSyncCode, fakeOps, validSubmit } from "./fixtures";

const ID = `sub_${"0123456789abcdef".repeat(2)}`;
const TOKEN = "a".repeat(43);
const COLLECTIBLE = {
  id: null,
  submissionId: ID,
  status: "draft",
  chain: null,
  contract: null,
  tokenId: null,
  txHash: null,
  metadataUri: null,
  marketplaceUrl: null,
  impactPackage: null,
  impactStatus: null,
  impactVerified: false,
};

describe("C6 unknown fields are rejected by every callable", () => {
  const cases: Array<[string, () => unknown]> = [
    ["submitArtwork", () => parseSubmitRequest(validSubmit({ derivedDataUrl: "data:," }))],
    ["submitArtwork permissions", () => parseSubmitRequest(validSubmit({ permissions: { store: true, admin: true } }))],
    ["finalizeSubmission", () => parseFinalizeRequest({ id: ID, finalizeToken: TOKEN, status: "approved" })],
    ["moderateSubmission", () => parseModerateRequest({ id: ID, status: "approved", role: "ADMIN" })],
    ["createGroup", () => parseCreateGroupRequest({ label: "x", publicId: "abcdef012345" })],
    ["getGroup", () => parseGetGroupRequest({ publicId: "abcdef012345", all: true })],
    ["upsertCollectible", () => parseCollectibleRequest({ ...COLLECTIBLE, price: 1 })],
  ];
  it.each(cases)("%s", (_name, run) => {
    expectSyncCode(run, "invalid-argument");
  });

  it.each([null, "text", [], 7])("rejects a non-object payload %j", (raw) => {
    expectSyncCode(() => parseSubmitRequest(raw), "invalid-argument");
    expectSyncCode(() => parseModerateRequest(raw), "invalid-argument");
    expectSyncCode(() => parseCollectibleRequest(raw), "invalid-argument");
  });

  it("rejects prototype tricks", () => {
    expectSyncCode(() => parseSubmitRequest(JSON.parse('{"__proto__": {"store": true}}')), "invalid-argument");
  });
});

describe("C6 enums, formats and caps", () => {
  it.each([
    ["submitterRole", "admin"],
    ["attributionKind", "fullName"],
    ["ageRange", "5"],
    ["pageId", "Z99"],
    ["pageId", "happy-pup"],
    ["originalMime", "image/gif"],
    ["showOrganization", "yes"],
    ["rotate", 45],
    ["rotate", "90"],
    ["cropPct", 0.5],
    ["cropPct", -0.1],
    ["cropPct", "0.1"],
    ["guardianConsentAttested", "true"],
  ])("rejects %s=%j", (field, value) => {
    expectSyncCode(() => parseSubmitRequest(validSubmit({ [field]: value })), "invalid-argument");
  });

  it("only real pages (or none)", () => {
    for (const id of PAGE_IDS) expect(parseSubmitRequest(validSubmit({ pageId: id })).pageId).toBe(id);
    expect(parseSubmitRequest(validSubmit({ pageId: null })).pageId).toBeNull();
  });

  it("group codes are 12 lowercase hex characters", () => {
    for (const bad of ["ABCDEF012345", "123", "abcdef01234z", "../../x", 5]) {
      expectSyncCode(() => parseSubmitRequest(validSubmit({ groupId: bad })), "invalid-argument");
    }
    expect(parseSubmitRequest(validSubmit({ groupId: "abcdef012345" })).groupPublicId).toBe("abcdef012345");
    expectSyncCode(() => parseGetGroupRequest({ publicId: "grp_1" }), "invalid-argument");
  });

  it("caps every free-text field", () => {
    expect(parseSubmitRequest(validSubmit({ attributionText: "a".repeat(80) })).attributionText).toHaveLength(80);
    expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionText: "a".repeat(81) })), "invalid-argument");
    expectSyncCode(() => parseSubmitRequest(validSubmit({ organizationName: "o".repeat(121) })), "invalid-argument");
    expect(parseSubmitRequest(validSubmit({ message: "m".repeat(2000) })).message).toHaveLength(2000);
    expectSyncCode(() => parseSubmitRequest(validSubmit({ message: "m".repeat(2001) })), "invalid-argument");
    expectSyncCode(() => parseSubmitRequest(validSubmit({ originalName: "n".repeat(256) })), "invalid-argument");
    expectSyncCode(() => parseModerateRequest({ id: ID, status: "hold", note: "n".repeat(2001) }), "invalid-argument");
    expectSyncCode(() => parseCreateGroupRequest({ label: "l".repeat(121) }), "invalid-argument");
    expect(parseCreateGroupRequest({}).label).toBe("Art day");
    expect(parseCreateGroupRequest(undefined).label).toBe("Art day");
  });

  it("rejects malformed emails and keeps good ones", () => {
    for (const bad of ["not-an-email", "a@b", "<x>@y.com", "a@b.c", "a b@c.com"]) {
      expectSyncCode(() => parseSubmitRequest(validSubmit({ email: bad })), "invalid-argument");
    }
    expect(parseSubmitRequest(validSubmit({ email: "grown.up+cfac@example.org" })).email).toBe("grown.up+cfac@example.org");
    expect(parseSubmitRequest(validSubmit({ email: "" })).email).toBeNull();
  });

  it("removes control and bidi-override characters", () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const rlo = String.fromCharCode(0x202e);
    const crlf = String.fromCharCode(13, 10);
    expect(cleanText(`Hi${nul} there${rlo}${bell}`, false)).toBe("Hi there");
    expect(cleanText(`line one${crlf}line two`, true)).toBe(`line one${String.fromCharCode(10)}line two`);
    expect(cleanText(`line one${crlf}line two`, false)).toBe("line one line two");
    expect(parseSubmitRequest(validSubmit({ attributionText: `${rlo}Sky${nul}` })).attributionText).toBe("Sky");
  });

  it("never stores a name for anonymous", () => {
    const anon = parseSubmitRequest(validSubmit({ attributionKind: "anonymous", attributionText: "Hidden" }));
    expect(anon.attributionText).toBe("");
    expect(parseSubmitRequest(validSubmit({ attributionKind: "anonymous", attributionText: "\u200b" })).attributionKind).toBe("anonymous");
  });

  it.each([["   "], ["\u200b\u200d\ufeff"], ["\u3164"], ["\u{e0041}\u{e0042}"], [" \u2060 "], [""]])(
    "refuses a name that is empty after cleaning: %j",
    (name) => {
      const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: name })), "invalid-argument");
      expect(err.message).toBe(NAME_REQUIRED);
    },
  );

  const INVISIBLES = [
    0x200b, 0x200d, 0x200e, 0x200f, 0x061c, 0xfeff, 0x180e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xe0000, 0xe0001, 0xe0041, 0xe007f,
  ];
  /** Ignorable or format characters that were on NO hand-written list: the property-based filter must catch them. */
  const UNLISTED = [0x00ad, 0x034f, 0x17b4, 0x180b, 0x2065, 0x206a, 0x206f, 0xfe00, 0xfe0f, 0xe0100, 0xe0080, 0xfff9, 0x1bca0, 0x1d173];

  it.each([...INVISIBLES, ...UNLISTED].map((cp) => [`U+${cp.toString(16).toUpperCase()}`, cp]))("strips invisible %s", (_name, cp) => {
    const ch = String.fromCodePoint(cp as number);
    expect(cleanText(`S${ch}k${ch}y${ch}`, false)).toBe("Sky");
    expect(cleanText(`one${ch}\ntwo`, true)).toBe("one\ntwo");
    expect(parseSubmitRequest(validSubmit({ attributionText: `${ch}Sky${ch}` })).attributionText).toBe("Sky");
    const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: ch + ch })), "invalid-argument");
    expect(err.message).toBe(NAME_REQUIRED);
  });

  it.each([0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x1d159].map((cp) => [`U+${cp.toString(16).toUpperCase()}`, cp]))(
    "treats visually blank %s as blank",
    (_name, cp) => {
      const ch = String.fromCodePoint(cp as number);
      expect(cleanText(`Sky${ch}`, false)).toBe("Sky");
      expect(cleanText(`${ch}${ch}Sky${ch}`, false)).toBe("Sky");
      const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "nickname", attributionText: `${ch}${ch}\u00ad` })), "invalid-argument");
      expect(err.message).toBe(NAME_REQUIRED);
      expect(parseCreateGroupRequest({ label: ch + ch }).label).toBe("Art day");
      expect(parseSubmitRequest(validSubmit({ organizationName: `${ch}\u00ad` })).organizationName).toBeNull();
    },
  );

  it("line and paragraph separators are line breaks", () => {
    expect(cleanText("one\u2028two\u2029three", true)).toBe("one\ntwo\nthree");
    expect(cleanText("one\u2028two", false)).toBe("one two");
  });

  it("keeps emoji sequences, keycaps and Persian/Indic spelling intact", () => {
    for (const s of ["👩\u200d🎨", "🏳\ufe0f\u200d🌈", "❤\ufe0f", "1\ufe0f\u20e3", "👨🏽\u200d🚀", "🧑\u200d🤝\u200d🧑", "🏴\u200d☠\ufe0f", "می\u200cنا", "क\u094d\u200cष"]) {
      expect(cleanText(s, false)).toBe(s);
      expect(parseSubmitRequest(validSubmit({ attributionText: s })).attributionText).toBe(s);
      expect(parseSubmitRequest(validSubmit({ message: `I made this ${s}` })).message).toBe(`I made this ${s}`);
    }
    // ...but a joiner or selector outside such a sequence is still stripped.
    expect(cleanText("Sky\u200d\ufe0f", false)).toBe("Sky");
    expect(cleanText("\u200c\u200dSky\u200c", false)).toBe("Sky");
  });

  it("normalizes to NFC after stripping", () => {
    const out = cleanText("e\u200b\u0301", false);
    expect(out).toBe("é");
    expect(out.normalize("NFC")).toBe(out);
  });

  it.each([["..."], ["\u0301\u0301"], ["–"], ["\u00ad\u2800"]])("a name needs a letter, digit or symbol: %j is refused", (name) => {
    const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: name })), "invalid-argument");
    expect(err.message).toBe(NAME_REQUIRED);
  });

  it.each([["Sky"], ["7"], ["🎨"], ["Zoë"], ["李"]])("a readable name is accepted: %j", (name) => {
    expect(parseSubmitRequest(validSubmit({ attributionText: name })).attributionText).toBe(name);
  });

  it("organization names and messages lose the same characters", () => {
    const junk = "\u00ad\ufe0f\u2065\u206a\u2800";
    const parsed = parseSubmitRequest(validSubmit({ organizationName: `Troop${junk} 5`, message: `Stay${junk} warm` }));
    expect(parsed.organizationName).toBe("Troop  5");
    expect(parsed.message).toBe("Stay  warm");
  });

  it("refuses lone surrogates but keeps real emoji", () => {
    for (const bad of ["Sky\ud800", "\udc00Sky", "a\ud83db"]) {
      const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionText: bad })), "invalid-argument");
      expect(err.message).toMatch(/could not read/);
      expectSyncCode(() => parseSubmitRequest(validSubmit({ message: bad })), "invalid-argument");
      expectSyncCode(() => cleanText(bad, false), "invalid-argument");
    }
    expect(parseSubmitRequest(validSubmit({ attributionText: "Sky 🎨" })).attributionText).toBe("Sky 🎨");
  });

  it("normalizes to NFC", () => {
    expect(cleanText("Zoe\u0308", false)).toBe("Zoë");
    expect(parseSubmitRequest(validSubmit({ attributionText: "Zoe\u0308" })).attributionText).toBe("Zoë");
  });

  it("booleans must be booleans", () => {
    expectSyncCode(() => parseSubmitRequest(validSubmit({ permissions: { store: 1 } })), "invalid-argument");
    expectSyncCode(() => parseSubmitRequest(validSubmit({ permissions: { store: "true" } })), "invalid-argument");
  });

  it("collectibles: enums and safe links only", () => {
    expect(parseCollectibleRequest({ ...COLLECTIBLE, metadataUri: "ipfs://bafybeigdyrzt" }).metadataUri).toBe("ipfs://bafybeigdyrzt");
    for (const bad of [
      { metadataUri: "javascript:alert(1)" },
      { marketplaceUrl: "http://market.example" },
      { status: "minted" },
      { impactPackage: "C" },
      { impactStatus: "maybe" },
      { submissionId: "sub_1" },
      { id: "col_1" },
      { chain: "Ethereum Mainnet" },
    ]) {
      expectSyncCode(() => parseCollectibleRequest({ ...COLLECTIBLE, ...bad }), "invalid-argument");
    }
  });

  it("finalize and moderate formats", () => {
    expectSyncCode(() => parseFinalizeRequest({ id: ID, finalizeToken: "short" }), "invalid-argument");
    expectSyncCode(() => parseFinalizeRequest({ id: "sub_x", finalizeToken: TOKEN }), "invalid-argument");
    expect(parseModerateRequest({ id: ID, status: "approved", derivedGeneration: "1712345678901234" }).derivedGeneration).toBe("1712345678901234");
    for (const bad of ["abc", "0", 12]) {
      expectSyncCode(() => parseModerateRequest({ id: ID, status: "approved", derivedGeneration: bad }), "invalid-argument");
    }
  });
});

describe("C6 public text is cleaned again when published (legacy rows)", () => {
  const legacy = (fields: Record<string, unknown>) => ({
    number: "NBC-ART-000001",
    attributionKind: "firstName",
    permissions: { displayPublic: true, showAttribution: true, showMessage: true },
    ...fields,
  });

  it("an invisible-only byline, message junk and a blank organization never reach the wall", () => {
    const doc = publicGalleryDoc(
      ID,
      legacy({ attributionText: "\u200b\u200b", message: "hi\u200bthere\u202e", organizationName: "\u2800\u00ad", showOrganization: true }),
      "approved",
      "https://example.test/x",
      fakeOps,
    );
    expect(doc).toMatchObject({ attributionKind: "anonymous", attributionText: "", message: "hithere", organizationName: null, showOrganization: false });
  });

  it("a legacy byline is cleaned, not dropped", () => {
    const doc = publicGalleryDoc(ID, legacy({ attributionText: "S\u00adky\u2800" }), "approved", "u", fakeOps);
    expect(doc).toMatchObject({ attributionKind: "firstName", attributionText: "Sky" });
  });

  it.each([["\u{034f}"], ["\u{3164}"], ["\u{fe00}"], ["\u{17b4}"], ["\u{e0100}"], ["\u{115f}\u{115f}"]])(
    "legacy text ending in ZWNJ + %j reaches the wall without the ZWNJ (byline, organization and message)",
    (x) => {
      const junk = `Sky\u{200c}${x}`;
      const doc = publicGalleryDoc(ID, legacy({ attributionText: junk, organizationName: junk, showOrganization: true, message: junk }), "approved", "u", fakeOps);
      expect(doc).toMatchObject({ attributionText: "Sky", organizationName: "Sky", message: "Sky" });
    },
  );

  it("a legacy byline that only looks like something (U+FFFC, Egyptian blanks, U+303F) goes on the wall as anonymous", () => {
    for (const text of ["\u{fffc}\u{fffc}", "\u{13441}\u{13442}", "\u{303f}", "\u{fffd}"]) {
      const doc = publicGalleryDoc(ID, legacy({ attributionText: text }), "approved", "u", fakeOps);
      expect(doc).toMatchObject({ attributionKind: "anonymous", attributionText: "" });
    }
  });

  it("a legacy page id or name kind outside the known values is not copied to the public doc", () => {
    const doc = publicGalleryDoc(ID, legacy({ attributionText: "Sky", pageId: "\u{202e}page\u{200b}", attributionKind: "\u{200b}firstName" }), "approved", "u", fakeOps);
    expect(doc).toMatchObject({ pageId: null, attributionKind: "firstName", attributionText: "Sky" });
    const nick = publicGalleryDoc(ID, legacy({ attributionText: "Sky", pageId: "E03", attributionKind: "nickname" }), "approved", "u", fakeOps);
    expect(nick).toMatchObject({ pageId: "E03", attributionKind: "nickname" });
  });
});

describe("C6 new blank and junk characters (round 3)", () => {
  it.each([["\u{fffc}"], ["\u{fffc}\u{fffc}"], ["\u{13441}\u{13442}"], ["\u{303f}"]])("a name of %j is refused", (name) => {
    const err = expectSyncCode(() => parseSubmitRequest(validSubmit({ attributionKind: "firstName", attributionText: name })), "invalid-argument");
    expect(err.message).toBe(NAME_REQUIRED);
  });

  it("a blank character does not make a second artist out of one", () => {
    const key = (attributionText: string) => artistKey({ attributionKind: "firstName", attributionText, permissions: { showAttribution: true } });
    expect(parseSubmitRequest(validSubmit({ attributionText: "Sky\u{fffc}" })).attributionText).toBe("Sky");
    expect(parseSubmitRequest(validSubmit({ attributionText: "Sky \u{13441}" })).attributionText).toBe("Sky");
    expect(key("Sky\u{fffc}")).toBe(key("Sky"));
    expect(key("Sky \u{13441}")).toBe(key("Sky"));
  });

  it("an invisible joiner between Latin letters no longer slips past the flags", () => {
    for (const word of ["n\u{200c}azi", "k\u{200c}ys", "po\u{200c}rn"]) {
      const parsed = parseSubmitRequest(validSubmit({ message: word }));
      expect(flagSubmission(parsed.message)).toContain("possible_harmful_language");
    }
  });

  it("names written with joiners in scripts that need them are kept, and a #/* keycap is a name", () => {
    for (const name of ["\u{0dc1}\u{0dca}\u{200d}\u{0dbb}\u{0dd3}", "\u{0d05}\u{0d28}\u{0d4d}\u{200d}\u{0d35}\u{0d7c}", "#\u{fe0f}\u{20e3}", "*\u{fe0f}\u{20e3}"]) {
      expect(parseSubmitRequest(validSubmit({ attributionText: name })).attributionText).toBe(name);
    }
  });
});

describe("C6 artist keys: one artist, one key", () => {
  const key = (attributionText: string) => artistKey({ attributionKind: "firstName", attributionText, permissions: { showAttribution: true } });

  it("lookalikes made with invisible, blank or joiner characters all count as the same artist", () => {
    const lookalikes = ["Sky", "S\u00adky", "Sky\ufe0f", "Sky\u2800", "Sk\u034fy", "Sky\u{e0100}", "Sk\u206ay", "Sk\u200cy", "SKY", " sky "];
    expect(new Set(lookalikes.map(key)).size).toBe(1);
    expect(bylineKey("STRASSE")).toBe(bylineKey("straße"));
    expect(key("Sky")).not.toBe(key("Skye"));
  });

  it("a name with nothing readable counts as anonymous", () => {
    expect(key("\u2800\u00ad")).toBe(artistKey({ attributionKind: "anonymous", attributionText: "", permissions: { showAttribution: true } }));
  });
});

describe("the client cleaning mirrors the server", () => {
  const corpus = [
    "Sky",
    "  Sky  ",
    "S\u00adky\u2800",
    "\u200b\u200d\ufeff",
    "👩\u200d🎨 and 🏳\ufe0f\u200d🌈",
    "1\ufe0f\u20e3 2\ufe0f\u20e3",
    "می\u200cنا",
    "Zoe\u0308",
    "e\u200b\u0301",
    "line one\r\nline two\u2028three",
    "tab\there",
    "Hi  there\u202e",
    "\u{e0041}\u{e0042}hidden",
    "\u2800\u2800",
    "\u3164",
    "...",
    "Sky\u200c",
  ];
  it.each(corpus.map((s) => [JSON.stringify(s), s]))("%s", (_label, s) => {
    for (const multiline of [false, true]) expect(clientCleanText(s, multiline)).toBe(cleanText(s, multiline));
    expect(clientHasReadableText(clientCleanText(s))).toBe(hasReadableText(cleanText(s, false)));
  });
});

describe("server lists match the site", () => {
  it("page ids", () => {
    expect([...PAGE_IDS]).toEqual(PAGES.map((p) => p.id));
  });
  it("public statuses", () => {
    expect([...SERVER_PUBLIC_STATUSES]).toEqual(PUBLIC_STATUSES);
  });
  it("permission keys", () => {
    expect([...PERMISSION_KEYS].sort()).toEqual(Object.keys(emptyPermissions()).sort());
  });
  it("consent version is unchanged", () => {
    expect(SERVER_CONSENT_VERSION).toBe(CONSENT_VERSION);
    expect(CONSENT_VERSION).toBe("0.1-DRAFT-LEGAL-REVIEW");
  });
  it("collectible fields", () => {
    expect([...COLLECTIBLE_FIELDS]).toEqual([...SERVER_COLLECTIBLE_FIELDS]);
  });
  it("the site sends only the collectible fields the server accepts", () => {
    // A row as listCollectibles reads it back: server fields included.
    const fromFirestore = {
      ...COLLECTIBLE,
      id: `col_${"b".repeat(32)}`,
      createdAt: { seconds: 1 },
      updatedAt: { seconds: 2 },
      updatedBy: "staff-impact",
    } as unknown as Collectible;
    expectSyncCode(() => parseCollectibleRequest(fromFirestore), "invalid-argument");
    const payload = collectiblePayload(fromFirestore);
    expect(Object.keys(payload).sort()).toEqual([...SERVER_COLLECTIBLE_FIELDS].sort());
    expect(parseCollectibleRequest(payload)).toMatchObject({ id: `col_${"b".repeat(32)}`, submissionId: ID, status: "draft" });
  });
});
