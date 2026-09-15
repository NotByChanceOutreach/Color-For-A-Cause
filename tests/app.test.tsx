import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import App from "../src/App";

function go(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("public routes", () => {
  it("renders the homepage thesis", () => {
    go("/");
    expect(screen.getByRole("heading", { name: /color something that can help someone stay warm/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /let’s make something/i })).toBeInTheDocument();
  });

  it("lists coloring pages", () => {
    go("/color");
    expect(screen.getByRole("heading", { name: /choose a page/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /happy pup/i })).toBeInTheDocument();
  });

  it("shows an honest empty art wall", () => {
    go("/wall");
    expect(screen.getByRole("heading", { name: /the art wall/i })).toBeInTheDocument();
  });

  it("does not require an account to submit", () => {
    go("/submit");
    expect(screen.getByRole("heading", { name: /send us your art/i })).toBeInTheDocument();
    expect(screen.queryByText(/create an account/i)).toBeNull();
    expect(screen.queryByText(/connect wallet/i)).toBeNull();
  });
});
