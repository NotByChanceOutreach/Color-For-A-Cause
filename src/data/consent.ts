import type { ConsentPermissions } from "../types";

export const CONSENT_VERSION = "0.1-DRAFT-LEGAL-REVIEW";

export const CONSENT_NOTICE =
  "This permission language is a working draft for the Color For A Cause software. It is not legal advice and must be reviewed by counsel before public launch.";

export const emptyPermissions = (): ConsentPermissions => ({
  store: false,
  displayPublic: false,
  social: false,
  reproduce: false,
  promotional: false,
  collectible: false,
  sellCollectible: false,
  showAttribution: false,
  showMessage: false,
});

export const CONSENT_FIELDS: {
  key: keyof ConsentPermissions;
  label: string;
  help: string;
  required?: boolean;
}[] = [
  {
    key: "store",
    label: "Not By Chance may store this artwork so they can review it.",
    help: "Needed so we can receive the file. We will not publish it just because we stored it.",
    required: true,
  },
  {
    key: "displayPublic",
    label: "If it is approved, you may show it on The Art Wall.",
    help: "Nothing goes public until a person at Not By Chance says yes.",
  },
  {
    key: "showAttribution",
    label: "You may show the name or nickname I chose next to the art.",
    help: "If you skip this, we can still show the art as Anonymous Artist (if display is allowed).",
  },
  {
    key: "showMessage",
    label: "You may show the message I wrote with the art.",
    help: "Your words stay yours. We will not rewrite them to sound “inspirational.”",
  },
  {
    key: "social",
    label: "You may share the art on Not By Chance social channels.",
    help: "Still only after a human review.",
  },
  {
    key: "reproduce",
    label: "You may reproduce the art in outreach materials (prints, slides, reports).",
    help: "Not a license for anyone else to sell it.",
  },
  {
    key: "promotional",
    label: "You may use the art to explain this community project.",
    help: "Posters, the website, a talk — not as a product photo for unrelated ads.",
  },
  {
    key: "collectible",
    label: "You may turn this art into a unique digital collectible (a 1-of-1).",
    help: "Optional. Submitting art does not mean it will become a collectible.",
  },
  {
    key: "sellCollectible",
    label: "If a collectible is created, Not By Chance may offer it to support outreach supplies.",
    help: "This is not an investment. There is no promised value, profit, or tax result.",
  },
];

export const MESSAGE_EXAMPLES = [
  "Stay warm.",
  "You matter.",
  "Hope you like it.",
  "Thank you for helping.",
  "Have a great day.",
  "I like eating chalk. :)",
  "Hi Mom.",
];
