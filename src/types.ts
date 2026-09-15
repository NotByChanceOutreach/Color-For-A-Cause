export type Complexity = "easy" | "standard" | "detailed";

export type PageTag =
  | "tent"
  | "sleeping-bag"
  | "friends"
  | "winter"
  | "lantern"
  | "outdoors"
  | "adventure";

export type ColoringPage = {
  id: string;
  title: string;
  slug: string;
  complexity: Complexity;
  tags: PageTag[];
  characters: Array<"pup" | "snug" | "lodge">;
  orientation: "portrait" | "landscape";
  featured: boolean;
  displayOrder: number;
  createdAt: string;
  active: boolean;
};

export type SubmitterRole = "self" | "guardian" | "organization" | "someone_else";
export type AttributionKind = "firstName" | "nickname" | "anonymous";
export type AgeRange = "prefer_not" | "under_13" | "13_17" | "18_plus";

export type SubmissionStatus =
  | "submitted"
  | "needs_changes"
  | "hold"
  | "approved"
  | "featured"
  | "scheduled"
  | "collectible_created"
  | "available"
  | "collected"
  | "impact_funded"
  | "impact_fulfilled"
  | "archived"
  | "rejected";

export const PUBLIC_STATUSES: SubmissionStatus[] = [
  "approved",
  "featured",
  "scheduled",
  "collectible_created",
  "available",
  "collected",
  "impact_funded",
  "impact_fulfilled",
];

/** Approved is not enough: public display also requires display consent. */
export function isPublicOnWall(s: {
  status: SubmissionStatus;
  permissions?: { displayPublic?: boolean } | null;
}): boolean {
  return PUBLIC_STATUSES.includes(s.status) && Boolean(s.permissions?.displayPublic);
}

export type ConsentPermissions = {
  store: boolean;
  displayPublic: boolean;
  social: boolean;
  reproduce: boolean;
  promotional: boolean;
  collectible: boolean;
  sellCollectible: boolean;
  showAttribution: boolean;
  showMessage: boolean;
};

export type ConsentRecord = {
  id: string;
  submissionId: string;
  documentVersion: string;
  submitterRole: SubmitterRole;
  permissions: ConsentPermissions;
  timestamp: string;
  userAgent: string;
};

export type Submission = {
  id: string;
  number: string;
  pageId: string | null;
  status: SubmissionStatus;
  submitterRole: SubmitterRole;
  attributionKind: AttributionKind;
  attributionText: string;
  ageRange: AgeRange | null;
  organizationName: string | null;
  showOrganization: boolean;
  message: string;
  email: string | null;
  groupId: string | null;
  flags: string[];
  consentId: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  staffNote: string | null;
  imageDataUrl: string;
  originalName: string;
  originalMime: string;
  originalBytes: number;
  permissions: ConsentPermissions;
  /** Staff only: the storage generation of the server-made image the reviewer is looking at. */
  derivedGeneration?: string | null;
  /** Staff only: false for pieces that never went through the server privacy check. */
  stripped?: boolean;
};

export type StaffRole = "ADMIN" | "REVIEWER" | "ART_MANAGER" | "IMPACT_MANAGER";

export type ImpactPackage = "A" | "B";
export type ImpactStatus = "not_yet_funded" | "funded" | "purchased" | "distributed";

export type Collectible = {
  id: string;
  submissionId: string;
  status: "none" | "draft" | "created";
  chain: string | null;
  contract: string | null;
  tokenId: string | null;
  txHash: string | null;
  metadataUri: string | null;
  marketplaceUrl: string | null;
  impactPackage: ImpactPackage | null;
  impactStatus: ImpactStatus | null;
  impactVerified: boolean;
};

/** What getGroup/createGroup return: the public QR code only, never the internal document id. */
export type Group = {
  publicId: string;
  label: string;
  createdAt: string;
};

export type AuditLog = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

export type PublicCounters = {
  artworkSubmitted: number;
  artistsParticipating: number;
  collectiblesCreated: number;
  tentsFunded: number;
  sleepingBagsFunded: number;
};

export type SubmitInput = {
  pageId: string | null;
  /** The original photo. It is the only thing uploaded. */
  file: File;
  /** On-device preview for the success screen. Never uploaded. */
  previewDataUrl: string;
  /** The artist's own straightening choices; the server applies them to the public image. */
  rotate: 0 | 90 | 180 | 270;
  cropPct: number;
  /** Organizations sending art by someone under 18 confirm a guardian agreed. */
  guardianConsentAttested: boolean;
  submitterRole: SubmitterRole;
  attributionKind: AttributionKind;
  attributionText: string;
  ageRange: AgeRange | null;
  organizationName: string | null;
  showOrganization: boolean;
  message: string;
  email: string | null;
  groupId: string | null;
  permissions: ConsentPermissions;
};
