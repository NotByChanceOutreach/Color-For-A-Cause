import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_FAILED, ROLE_CANNOT_SEE, RoleCannotSeeError, isPermissionDenied, staffLoadError } from "../src/lib/staffErrors";

const mockApi = vi.hoisted(() => ({
  listAllSubmissions: vi.fn(),
  audits: vi.fn(),
  listCollectibles: vi.fn(),
  getStaffSubmission: vi.fn(),
  currentStaff: vi.fn(() => ({ email: "impact@example.org", role: "IMPACT_MANAGER" })),
  waitForStaff: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/api", () => ({ api: mockApi, useFirebase: () => false }));

const { StaffHome, StaffImpact, StaffLogs, StaffReview, StaffSubmissions } = await import("../src/pages/Admin");

/** What the Firestore web SDK rejects with when rules deny a read. */
const firestoreDenied = () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });

function show(node: ReactNode, path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/staff/submissions/:id" element={node} />
        <Route path="*" element={node} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of [mockApi.listAllSubmissions, mockApi.audits, mockApi.listCollectibles, mockApi.getStaffSubmission]) fn.mockReset();
});

describe("staff pages explain what a role can't see", () => {
  it.each([
    ["Overview", () => <StaffHome />, "listAllSubmissions"],
    ["Submissions", () => <StaffSubmissions />, "listAllSubmissions"],
    ["Audit log", () => <StaffLogs />, "audits"],
    ["Impact", () => <StaffImpact />, "listCollectibles"],
  ] as const)("%s: permission-denied shows the plain message, not a rejection", async (_name, page, method) => {
    mockApi[method].mockRejectedValue(firestoreDenied());
    show(page());
    expect(await screen.findByText(ROLE_CANNOT_SEE)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a role the backend refuses up front (audit log for non-admins) gets the same message", async () => {
    mockApi.audits.mockRejectedValue(new RoleCannotSeeError());
    show(<StaffLogs />);
    expect(await screen.findByText("Your role can't see this.")).toBeInTheDocument();
  });

  it("the review page says so too", async () => {
    mockApi.getStaffSubmission.mockRejectedValue(new RoleCannotSeeError());
    show(<StaffReview />, `/staff/submissions/sub_${"a".repeat(32)}`);
    expect(await screen.findByText(ROLE_CANNOT_SEE)).toBeInTheDocument();
  });

  it("any other failure gets a try-again line", async () => {
    mockApi.listAllSubmissions.mockRejectedValue(new Error("network down"));
    show(<StaffSubmissions />);
    expect(await screen.findByText(LIST_FAILED)).toBeInTheDocument();
  });

  it("lists still show for roles that may read them", async () => {
    mockApi.audits.mockResolvedValue([{ id: "a1", at: "2026-09-15T00:00:00Z", actor: "system", action: "retention", target: "submissions", detail: "" }]);
    show(<StaffLogs />);
    expect(await screen.findByText("retention")).toBeInTheDocument();
    expect(screen.queryByText(ROLE_CANNOT_SEE)).toBeNull();
  });

  it("recognises permission errors from Firestore, Storage and the backend", () => {
    expect(isPermissionDenied(firestoreDenied())).toBe(true);
    expect(isPermissionDenied({ code: "firestore/permission-denied" })).toBe(true);
    expect(isPermissionDenied({ code: "storage/unauthorized" })).toBe(true);
    expect(isPermissionDenied(new RoleCannotSeeError())).toBe(true);
    expect(isPermissionDenied(new Error("x"))).toBe(false);
    expect(staffLoadError({ code: "unavailable" })).toBe(LIST_FAILED);
  });
});
