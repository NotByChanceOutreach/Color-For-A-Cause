import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { api } from "../src/lib/api";
import { buildActivityPack } from "../src/lib/packs";
import { PACK_GROUP_KEY } from "../src/pages/Packs";

vi.mock("../src/lib/packs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/packs")>()),
  buildActivityPack: vi.fn(async () => new Blob(["%PDF-1.7"], { type: "application/pdf" })),
  downloadBlob: vi.fn(),
}));

function go() {
  return render(
    <MemoryRouter initialEntries={["/packs"]}>
      <App />
    </MemoryRouter>,
  );
}

async function download(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = screen.getByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(button).toBeEnabled());
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(buildActivityPack).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Activity packs share one group code per browser session", () => {
  it("creates the group once and reuses it for every later PDF", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createGroup")
      .mockResolvedValue({ publicId: "abcdef012345", label: "Activity pack", createdAt: new Date(0).toISOString() });
    go();
    await download(user, "Easy activity pack");
    await download(user, "Mixed activity pack");
    await download(user, "Full collection");
    expect(create).toHaveBeenCalledTimes(1);
    const codes = vi.mocked(buildActivityPack).mock.calls.map(([opts]) => opts.groupPublicId);
    expect(codes).toEqual(["abcdef012345", "abcdef012345", "abcdef012345"]);
    expect(sessionStorage.getItem(PACK_GROUP_KEY)).toBe("abcdef012345");
  });

  it("when a group cannot be made, the pack still prints without one and the next download tries again", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createGroup")
      .mockRejectedValueOnce(new Error("resource-exhausted"))
      .mockResolvedValue({ publicId: "0123456789ab", label: "Activity pack", createdAt: new Date(0).toISOString() });
    go();
    await download(user, "Easy activity pack");
    await download(user, "Easy activity pack");
    await download(user, "Easy activity pack");
    expect(create).toHaveBeenCalledTimes(2);
    const codes = vi.mocked(buildActivityPack).mock.calls.map(([opts]) => opts.groupPublicId);
    expect(codes).toEqual([undefined, "0123456789ab", "0123456789ab"]);
  });

  it("ignores a tampered session value", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(PACK_GROUP_KEY, "../../evil");
    const create = vi
      .spyOn(api, "createGroup")
      .mockResolvedValue({ publicId: "abcdef012345", label: "Activity pack", createdAt: new Date(0).toISOString() });
    go();
    await download(user, "Easy activity pack");
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildActivityPack).mock.calls[0][0].groupPublicId).toBe("abcdef012345");
  });
});
