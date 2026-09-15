import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { api } from "../src/lib/api";
import { HEIC_MESSAGE, looksAllowed, uploadContentType } from "../src/lib/files";
import { NAME_REQUIRED, ServerRefusal, isPieceRefusal } from "../src/lib/refusals";
import { STORE_NEEDED, UNREADABLE_NAME } from "../src/pages/GroupSubmit";
import {
  GUARDIAN_ATTESTATION_LABEL,
  MINOR_LOCK_REASON,
  ORGANIZATION_LOCK_HINT,
  UNKNOWN_AGE_EMAIL_REASON,
  UNKNOWN_AGE_LOCK_REASON,
} from "../src/lib/minors";

// jsdom has no canvas: give the on-device preview a stand-in so the forms can send.
vi.mock("../src/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/files")>()),
  makeDerivative: async () => ({ dataUrl: "data:image/jpeg;base64,AA==", width: 1, height: 1 }),
}));

const SHOW_ON_WALL = "If it is approved, you may show it on The Art Wall.";
const STORE = "Not By Chance may store this artwork so they can review it.";
const NAME_QUESTION = /How should we name the artist in public/;

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], "art.jpg", { type: "image/jpeg" });

function go(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function toWhoMadeThis(user: ReturnType<typeof userEvent.setup>) {
  go("/submit");
  await user.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(document.querySelector('input[name="photo-file"]')!, { target: { files: [photo()] } });
  const next = screen.getByRole("button", { name: "Next" });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Who made this?");
}

describe("Submit form: unknown age is treated as a possible minor", () => {
  it("hides the public-naming question and explains why until the artist is 18+", async () => {
    const user = userEvent.setup();
    await toWhoMadeThis(user);
    expect(screen.getByText(UNKNOWN_AGE_LOCK_REASON)).toBeInTheDocument();
    expect(screen.queryByText(NAME_QUESTION)).toBeNull();

    const age = screen.getByLabelText("Age range (optional)");
    await user.selectOptions(age, "18_plus");
    expect(screen.getByText(NAME_QUESTION)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_AGE_LOCK_REASON)).toBeNull();

    await user.selectOptions(age, "under_13");
    expect(screen.getByText(MINOR_LOCK_REASON)).toBeInTheDocument();
    expect(screen.queryByText(NAME_QUESTION)).toBeNull();

    await user.selectOptions(screen.getByLabelText("Who created this artwork?"), "guardian");
    expect(screen.getByText(NAME_QUESTION)).toBeInTheDocument();
  });

  it("sends a locked, nameless, emailless piece when the age is not given", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    await toWhoMadeThis(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(UNKNOWN_AGE_EMAIL_REASON)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email if you want/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByLabelText(SHOW_ON_WALL, { exact: false })).toBeDisabled();
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0][0];
    expect(sent).toMatchObject({ submitterRole: "self", ageRange: "prefer_not", attributionKind: "anonymous", attributionText: "", email: null });
    expect(sent.permissions).toMatchObject({ store: true, displayPublic: false, showAttribution: false, showMessage: false });
  });
});

describe("Submit form: an organization answers the naming question where it ticks the guardian box (round 4, G)", () => {
  it("the question appears on the permission step once the box is ticked, so nobody has to go back two steps", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    await toWhoMadeThis(user);
    await user.selectOptions(screen.getByLabelText("Who created this artwork?"), "organization");
    expect(screen.queryByText(NAME_QUESTION)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Permission")).toBeInTheDocument();
    expect(screen.queryByText(NAME_QUESTION)).toBeNull();
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    expect(screen.getByText(NAME_QUESTION)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name or nickname"), "Sky");
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      submitterRole: "organization",
      attributionKind: "firstName",
      attributionText: "Sky",
      guardianConsentAttested: true,
    });
  });

  it("choosing Anonymous right there sends without a name", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    await toWhoMadeThis(user);
    await user.selectOptions(screen.getByLabelText("Who created this artwork?"), "organization");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    await user.click(screen.getByLabelText("Anonymous"));
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({ attributionKind: "anonymous", attributionText: "" });
  });
});

describe("Submit form: names and photo types are judged like the server does", () => {
  it("a name of only invisible or blank characters is caught before sending", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    await toWhoMadeThis(user);
    await user.selectOptions(screen.getByLabelText("Age range (optional)"), "18_plus");
    fireEvent.change(screen.getByLabelText("Name or nickname"), { target: { value: "\u200b\u2800\u00ad" } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    expect((await screen.findAllByText("Type a first name, a nickname, or choose Anonymous.")).length).toBeGreaterThan(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends the cleaned name", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    await toWhoMadeThis(user);
    await user.selectOptions(screen.getByLabelText("Age range (optional)"), "18_plus");
    fireEvent.change(screen.getByLabelText("Name or nickname"), { target: { value: " S\u00adky\u2800 " } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({ attributionKind: "firstName", attributionText: "Sky" });
  });

  it("the server decides names: its refusal is shown at the name question, and fixing the name clears it (round 4, D)", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit").mockRejectedValueOnce(new ServerRefusal("invalid-argument", NAME_REQUIRED));
    await toWhoMadeThis(user);
    await user.selectOptions(screen.getByLabelText("Age range (optional)"), "18_plus");
    fireEvent.change(screen.getByLabelText("Name or nickname"), { target: { value: "Sky" } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText(STORE, { exact: false }));
    await user.click(screen.getByRole("button", { name: "Send it to Not By Chance" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(NAME_REQUIRED)).toBeInTheDocument();
    expect(screen.getByText("Who made this?")).toBeInTheDocument();
    expect(screen.getByLabelText("Name or nickname")).toHaveValue("Sky");
    fireEvent.change(screen.getByLabelText("Name or nickname"), { target: { value: "Skye" } });
    expect(screen.queryByText(NAME_REQUIRED)).toBeNull();
  });

  it.each([
    ["IMG_0001.HEIC", "image/heic"],
    ["IMG_0002.heif", "image/heif"],
    ["IMG_0003.heic", ""],
    ["IMG_0004.HEIC", "image/jpeg"],
    ["burst.jpg", "image/heic-sequence"],
  ])("refuses HEIC/HEIF by type or extension: %s (%s)", (name, type) => {
    const f = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], name, { type });
    expect(looksAllowed(f)).toBe(HEIC_MESSAGE);
    expect(uploadContentType(f)).toBeNull();
  });

  it("shows the HEIC message on the form and keeps the step closed", async () => {
    const user = userEvent.setup();
    go("/submit");
    await user.click(screen.getByRole("button", { name: "Next" }));
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], "IMG_0001.HEIC", { type: "image/heic" });
    fireEvent.change(document.querySelector('input[name="photo-file"]')!, { target: { files: [heic] } });
    expect(await screen.findByText(HEIC_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("still accepts JPG, PNG and WEBP", () => {
    for (const [name, type] of [
      ["a.jpg", "image/jpeg"],
      ["b.png", "image/png"],
      ["c.webp", "image/webp"],
      ["d.JPG", ""],
    ]) {
      expect(looksAllowed(new File([new Uint8Array([1, 2, 3])], name, { type }))).toBeNull();
    }
  });
});

describe("Group form: unknown age is treated as a possible minor", () => {
  it("keeps a row private and nameless until it is 18+ or a guardian's agreement is confirmed", async () => {
    const user = userEvent.setup();
    go("/submit/group");
    expect(screen.getByText(`${UNKNOWN_AGE_LOCK_REASON} ${ORGANIZATION_LOCK_HINT}`)).toBeInTheDocument();
    expect(screen.queryByLabelText("Artist name or nickname (optional)")).toBeNull();
    expect(screen.getByLabelText(SHOW_ON_WALL)).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Age range (optional)"), "18_plus");
    expect(screen.getByLabelText("Artist name or nickname (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText(SHOW_ON_WALL)).toBeEnabled();

    await user.selectOptions(screen.getByLabelText("Age range (optional)"), "prefer_not");
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    expect(screen.getByLabelText("Artist name or nickname (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText(SHOW_ON_WALL)).toBeEnabled();
  });

  it("sends a locked row private and nameless", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    go("/submit/group");
    fireEvent.change(screen.getByLabelText("Photo for artwork 1"), { target: { files: [photo()] } });
    await user.click(screen.getByLabelText(STORE));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0][0];
    expect(sent).toMatchObject({ submitterRole: "organization", ageRange: "prefer_not", attributionKind: "anonymous", attributionText: "", guardianConsentAttested: false });
    expect(sent.permissions).toMatchObject({ store: true, displayPublic: false, showMessage: false, collectible: false });
  });

  it("a name of only invisible characters flags that row and the rest of the batch still goes", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    go("/submit/group");
    await user.click(screen.getByRole("button", { name: "Add another artwork" }));
    fireEvent.change(screen.getByLabelText("Photo for artwork 1"), { target: { files: [photo()] } });
    fireEvent.change(screen.getByLabelText("Photo for artwork 2"), { target: { files: [photo()] } });
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    const names = screen.getAllByLabelText("Artist name or nickname (optional)");
    fireEvent.change(names[0], { target: { value: "\u200b\u00ad\u2800" } });
    fireEvent.change(names[1], { target: { value: "Sky\u00ad" } });
    for (const box of screen.getAllByLabelText(STORE)) await user.click(box);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send this batch" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({ attributionKind: "nickname", attributionText: "Sky" });
    expect(await screen.findByText(UNREADABLE_NAME)).toBeInTheDocument();
    expect(screen.getByText(/Not sent yet: artwork 1\./)).toBeInTheDocument();

    // Clearing the name sends the flagged row without one; the row already sent is not sent again.
    fireEvent.change(screen.getAllByLabelText("Artist name or nickname (optional)")[0], { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toMatchObject({ attributionKind: "anonymous", attributionText: "" });
  });

  it("a row the SERVER refuses is flagged and the rest of the batch still goes, all under one group code (round 4, D and G)", async () => {
    const user = userEvent.setup();
    const createGroup = vi.spyOn(api, "createGroup");
    // The browser's Unicode tables can be newer than the server's: the form accepts a name the server refuses.
    const submit = vi.spyOn(api, "submit").mockRejectedValueOnce(new ServerRefusal("invalid-argument", NAME_REQUIRED));
    go("/submit/group");
    await user.click(screen.getByRole("button", { name: "Add another artwork" }));
    fireEvent.change(screen.getByLabelText("Photo for artwork 1"), { target: { files: [photo()] } });
    fireEvent.change(screen.getByLabelText("Photo for artwork 2"), { target: { files: [photo()] } });
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    const names = screen.getAllByLabelText("Artist name or nickname (optional)");
    fireEvent.change(names[0], { target: { value: "Sky" } });
    fireEvent.change(names[1], { target: { value: "River" } });
    for (const box of screen.getAllByLabelText(STORE)) await user.click(box);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send this batch" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toMatchObject({ attributionText: "River" });
    expect(await screen.findByText(UNREADABLE_NAME)).toBeInTheDocument();
    expect(screen.getByText(/Not sent yet: artwork 1\./)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText((_, el) => el?.tagName === "LEGEND" && /Artwork 2 · NBC-ART-\d+/.test(el.textContent ?? ""))).toBeInTheDocument(),
    );

    // Fix the name and press again: only the flagged row goes, with the same group code.
    fireEvent.change(screen.getAllByLabelText("Artist name or nickname (optional)")[0], { target: { value: "Skye" } });
    expect(screen.queryByText(UNREADABLE_NAME)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    expect(submit.mock.calls[2][0]).toMatchObject({ attributionText: "Skye" });
    expect(createGroup).toHaveBeenCalledTimes(1);
    const codes = submit.mock.calls.map((c) => c[0].groupId);
    expect(codes[0]).toMatch(/^[0-9a-z]{12}$/);
    expect(new Set(codes).size).toBe(1);
  });

  it("a row with the store box unticked is flagged and the rest of the batch still goes (round 5)", async () => {
    const user = userEvent.setup();
    const createGroup = vi.spyOn(api, "createGroup");
    const submit = vi.spyOn(api, "submit");
    go("/submit/group");
    await user.click(screen.getByRole("button", { name: "Add another artwork" }));
    await user.click(screen.getByRole("button", { name: "Add another artwork" }));
    for (const n of [1, 2, 3]) fireEvent.change(screen.getByLabelText(`Photo for artwork ${n}`), { target: { files: [photo()] } });
    await waitFor(() => expect(document.querySelectorAll("fieldset img")).toHaveLength(3));
    const boxes = screen.getAllByLabelText(STORE);
    await user.click(boxes[0]);
    await user.click(boxes[2]); // row 2's store box stays unticked
    await user.click(screen.getByRole("button", { name: "Send this batch" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.every((c) => c[0].permissions.store === true)).toBe(true);
    expect(await screen.findByText(STORE_NEEDED)).toBeInTheDocument();
    expect(screen.getByText(/Not sent yet: artwork 2\./)).toBeInTheDocument();
    for (const n of [1, 3]) {
      await waitFor(() =>
        expect(
          screen.getByText((_, el) => el?.tagName === "LEGEND" && new RegExp(`Artwork ${n} · NBC-ART-\\d+`).test(el.textContent ?? "")),
        ).toBeInTheDocument(),
      );
    }

    // Tick row 2's box (its note goes) and press again: only row 2 goes, under the same group code.
    await user.click(screen.getAllByLabelText(STORE)[1]);
    expect(screen.queryByText(STORE_NEEDED)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    expect(submit.mock.calls[2][0].permissions.store).toBe(true);
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(new Set(submit.mock.calls.map((c) => c[0].groupId)).size).toBe(1);
  });

  it("the backend's own store check is a refusal of that one piece, so a batch never stops on it", async () => {
    const err = await api
      .submit({
        pageId: null,
        file: photo(),
        previewDataUrl: "data:image/jpeg;base64,AA==",
        rotate: 0,
        cropPct: 0,
        submitterRole: "organization",
        attributionKind: "anonymous",
        attributionText: "",
        ageRange: "18_plus",
        organizationName: null,
        showOrganization: false,
        message: "",
        email: null,
        groupId: null,
        permissions: { store: false, displayPublic: false, social: false, reproduce: false, promotional: false, collectible: false, sellCollectible: false, showAttribution: false, showMessage: false },
        guardianConsentAttested: false,
      })
      .catch((e: unknown) => e);
    expect(isPieceRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(/permission to store/);
  });

  it("a failure that is not a refusal of one piece still stops the batch", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit").mockRejectedValueOnce(new Error("Whoops. That picture didn’t make it through. Let’s try again."));
    go("/submit/group");
    await user.click(screen.getByRole("button", { name: "Add another artwork" }));
    fireEvent.change(screen.getByLabelText("Photo for artwork 1"), { target: { files: [photo()] } });
    fireEvent.change(screen.getByLabelText("Photo for artwork 2"), { target: { files: [photo()] } });
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    for (const box of screen.getAllByLabelText(STORE)) await user.click(box);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    expect(await screen.findByText(/didn’t make it through/)).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("with the guardian confirmation, the row's own choices and name go through", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(api, "submit");
    go("/submit/group");
    fireEvent.change(screen.getByLabelText("Photo for artwork 1"), { target: { files: [photo()] } });
    await user.click(screen.getByLabelText(GUARDIAN_ATTESTATION_LABEL));
    await user.type(screen.getByLabelText("Artist name or nickname (optional)"), "Sky");
    await user.click(screen.getByLabelText(STORE));
    await user.click(screen.getByLabelText(SHOW_ON_WALL));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send this batch" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      attributionKind: "nickname",
      attributionText: "Sky",
      guardianConsentAttested: true,
      permissions: expect.objectContaining({ store: true, displayPublic: true }),
    });
  });
});
