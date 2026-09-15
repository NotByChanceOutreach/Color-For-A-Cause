import type { ColoringPage, Complexity, PageTag } from "../types";

export const PAGES: ColoringPage[] = [
  { id: "E01", title: "Happy Pup", slug: "happy-pup", complexity: "easy", tags: ["tent"], characters: ["pup"], orientation: "portrait", featured: true, displayOrder: 1, createdAt: "2026-09-14", active: true },
  { id: "E02", title: "Simple Snug", slug: "simple-snug", complexity: "easy", tags: ["sleeping-bag"], characters: ["snug"], orientation: "portrait", featured: true, displayOrder: 2, createdAt: "2026-09-14", active: true },
  { id: "E03", title: "Friendly Lodge", slug: "friendly-lodge", complexity: "easy", tags: ["tent"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 3, createdAt: "2026-09-14", active: true },
  { id: "E04", title: "Waving Pup", slug: "waving-pup", complexity: "easy", tags: ["tent"], characters: ["pup"], orientation: "portrait", featured: false, displayOrder: 4, createdAt: "2026-09-14", active: true },
  { id: "E05", title: "Big Winter Hat", slug: "big-winter-hat", complexity: "easy", tags: ["sleeping-bag", "winter"], characters: ["snug"], orientation: "portrait", featured: true, displayOrder: 5, createdAt: "2026-09-14", active: true },
  { id: "E06", title: "Lantern Friend", slug: "lantern-friend", complexity: "easy", tags: ["tent", "lantern"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 6, createdAt: "2026-09-14", active: true },
  { id: "E07", title: "Two Friends", slug: "two-friends", complexity: "easy", tags: ["friends", "tent", "sleeping-bag"], characters: ["pup", "snug"], orientation: "portrait", featured: true, displayOrder: 7, createdAt: "2026-09-14", active: true },
  { id: "E08", title: "Stacked Bags", slug: "stacked-bags", complexity: "easy", tags: ["tent", "sleeping-bag"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 8, createdAt: "2026-09-14", active: true },
  { id: "S01", title: "Warm Drink", slug: "warm-drink", complexity: "standard", tags: ["sleeping-bag", "winter"], characters: ["snug"], orientation: "portrait", featured: true, displayOrder: 9, createdAt: "2026-09-14", active: true },
  { id: "S02", title: "Map Reader", slug: "map-reader", complexity: "standard", tags: ["tent", "adventure"], characters: ["pup"], orientation: "portrait", featured: false, displayOrder: 10, createdAt: "2026-09-14", active: true },
  { id: "S03", title: "Snow Day", slug: "snow-day", complexity: "standard", tags: ["tent", "winter"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 11, createdAt: "2026-09-14", active: true },
  { id: "S04", title: "Backpack Pup", slug: "backpack-pup", complexity: "standard", tags: ["tent", "adventure"], characters: ["pup"], orientation: "portrait", featured: false, displayOrder: 12, createdAt: "2026-09-14", active: true },
  { id: "S05", title: "Little Camp", slug: "little-camp", complexity: "standard", tags: ["tent", "outdoors", "lantern", "winter"], characters: ["pup"], orientation: "portrait", featured: true, displayOrder: 13, createdAt: "2026-09-14", active: true },
  { id: "S06", title: "Knit Cap Lodge", slug: "knit-cap-lodge", complexity: "standard", tags: ["tent", "winter", "outdoors"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 14, createdAt: "2026-09-14", active: true },
  { id: "S07", title: "Outreach Supplies", slug: "outreach-supplies", complexity: "standard", tags: ["sleeping-bag", "lantern", "adventure"], characters: ["snug"], orientation: "portrait", featured: true, displayOrder: 15, createdAt: "2026-09-14", active: true },
  { id: "S08", title: "Helping Hands", slug: "helping-hands", complexity: "standard", tags: ["friends", "tent", "sleeping-bag"], characters: ["snug", "pup"], orientation: "portrait", featured: true, displayOrder: 16, createdAt: "2026-09-14", active: true },
  { id: "D01", title: "Winter Forest", slug: "winter-forest", complexity: "detailed", tags: ["tent", "outdoors", "winter"], characters: ["lodge"], orientation: "portrait", featured: false, displayOrder: 17, createdAt: "2026-09-14", active: true },
  { id: "D02", title: "Quiet Bridge", slug: "quiet-bridge", complexity: "detailed", tags: ["tent", "outdoors"], characters: ["pup"], orientation: "portrait", featured: false, displayOrder: 18, createdAt: "2026-09-14", active: true },
  { id: "D03", title: "Mountain Camp", slug: "mountain-camp", complexity: "detailed", tags: ["tent", "outdoors", "adventure", "winter"], characters: ["pup"], orientation: "portrait", featured: true, displayOrder: 19, createdAt: "2026-09-14", active: true },
  { id: "D04", title: "Full Campsite", slug: "full-campsite", complexity: "detailed", tags: ["friends", "outdoors", "lantern", "winter"], characters: ["lodge", "snug"], orientation: "portrait", featured: false, displayOrder: 20, createdAt: "2026-09-14", active: true },
  { id: "D05", title: "Trail Pack", slug: "trail-pack", complexity: "detailed", tags: ["sleeping-bag", "adventure", "outdoors"], characters: ["snug"], orientation: "portrait", featured: false, displayOrder: 21, createdAt: "2026-09-14", active: true },
  { id: "D06", title: "Night Watch", slug: "night-watch", complexity: "detailed", tags: ["tent", "lantern", "winter"], characters: ["lodge"], orientation: "portrait", featured: true, displayOrder: 22, createdAt: "2026-09-14", active: true },
  { id: "D07", title: "Sharing Warmth", slug: "sharing-warmth", complexity: "detailed", tags: ["friends", "tent", "sleeping-bag", "lantern"], characters: ["lodge", "snug"], orientation: "portrait", featured: true, displayOrder: 23, createdAt: "2026-09-14", active: true },
  { id: "D08", title: "Family Camp", slug: "family-camp", complexity: "detailed", tags: ["friends", "outdoors", "winter", "adventure"], characters: ["lodge", "pup", "snug"], orientation: "portrait", featured: true, displayOrder: 24, createdAt: "2026-09-14", active: true },
];

export const COMPLEXITY_FILTERS: { id: Complexity; label: string }[] = [
  { id: "easy", label: "Easy" },
  { id: "standard", label: "Standard" },
  { id: "detailed", label: "Detailed" },
];

export const THEME_FILTERS: { id: PageTag; label: string }[] = [
  { id: "tent", label: "Tent" },
  { id: "sleeping-bag", label: "Sleeping bag" },
  { id: "friends", label: "Friends" },
  { id: "winter", label: "Winter" },
  { id: "lantern", label: "Lantern" },
  { id: "outdoors", label: "Outdoors" },
  { id: "adventure", label: "Adventure" },
];

export function pageBySlug(slug: string) {
  return PAGES.find((p) => p.slug === slug);
}

export function pageById(id: string) {
  return PAGES.find((p) => p.id === id);
}

export function thumbUrl(slug: string) {
  return `/library/thumbs/${slug}.jpg`;
}
export function previewUrl(slug: string) {
  return `/library/preview/${slug}.jpg`;
}
export function pngUrl(slug: string) {
  return `/library/print/${slug}.png`;
}
export function pdfUrl(slug: string) {
  return `/library/print/${slug}.pdf`;
}

export function matchesFilter(page: ColoringPage, filter: string) {
  if (filter === "easy" || filter === "standard" || filter === "detailed") {
    return page.complexity === filter;
  }
  return page.tags.includes(filter as PageTag);
}

export function matchesCatalog(
  page: ColoringPage,
  complexity: Complexity | null,
  theme: PageTag | null,
) {
  if (complexity && page.complexity !== complexity) return false;
  if (theme && !page.tags.includes(theme)) return false;
  return true;
}

export function emptyCatalogCopy(complexity: Complexity | null, theme: PageTag | null) {
  const style = COMPLEXITY_FILTERS.find((f) => f.id === complexity)?.label;
  const subject = THEME_FILTERS.find((f) => f.id === theme)?.label;
  if (style && subject) return `No ${style} ${subject} pages yet. Try another style or theme.`;
  if (style) return `No ${style} pages yet. Try another style or theme.`;
  if (subject) return `No ${subject} pages yet. Try another style or theme.`;
  return "No pages match those filters. Try another style or theme.";
}

export const EASY_PACK = PAGES.filter((p) => p.complexity === "easy").map((p) => p.slug);
export const MIXED_PACK = [
  "happy-pup",
  "simple-snug",
  "friendly-lodge",
  "warm-drink",
  "little-camp",
  "helping-hands",
  "mountain-camp",
  "sharing-warmth",
];
export const FULL_PACK = PAGES.map((p) => p.slug);
