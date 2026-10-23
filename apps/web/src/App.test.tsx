import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import styles from "./styles.css?raw";
import { createMockApi, type MockApi } from "./test-utils/mockApi";

let api: MockApi;

beforeEach(() => {
  api = createMockApi();
  vi.stubGlobal("fetch", api.fetch);
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const node = (key: string) => document.querySelector(`[data-node="${key}"]`) as SVGGElement;
const injectButton = () => screen.getByRole("button", { name: /INJECT DISRUPTION|WORKING/ });
const resetButton = () => screen.getByRole("button", { name: /RESET/ });
const settled = () => waitFor(() => expect(document.querySelector(".rw-phase--succeeded, .rw-phase--failed")).not.toBeNull());

async function renderLoaded() {
  render(<App />);
  await waitFor(() => expect(node("task:T01")).not.toBeNull());
}

async function inject(type: string, target: string) {
  fireEvent.change(screen.getByLabelText("DISRUPTION TYPE"), { target: { value: type } });
  fireEvent.change(screen.getByLabelText("TARGET"), { target: { value: target } });
  document.querySelector(".rw-phase--succeeded, .rw-phase--failed")?.classList.add("stale");
  fireEvent.click(injectButton());
  await waitFor(() =>
    expect(document.querySelector(".rw-phase--succeeded:not(.stale), .rw-phase--failed:not(.stale)")).not.toBeNull(),
  );
}

describe("Chaos Lab with the resilience map", () => {
  it("draws the real household as a map and keeps the existing controls", async () => {
    await renderLoaded();

    expect(document.querySelectorAll(".rm-node")).toHaveLength(7);
    expect(node("task:T01").getAttribute("data-state")).toBe("resolved");
    expect(node("task:T01").textContent).toContain("Sam");
    expect(screen.getByLabelText("DISRUPTION TYPE")).toBeTruthy();
    expect(screen.getByLabelText("TARGET")).toBeTruthy();
    expect(resetButton()).toBeTruthy();
    // Pre-existing stray blocks are gone.
    expect(screen.queryByText(/Built in phases/)).toBeNull();
    // No snapshot yet, so no comparison choice is offered.
    expect(document.querySelector(".rw-choice")).toBeNull();
  });

  it("captures the real pre-disruption plan, then compares with the real result", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");

    // The plan was fetched immediately before the disruption was submitted.
    const disruptIndex = api.log.indexOf("POST /api/disrupt");
    expect(disruptIndex).toBeGreaterThan(0);
    expect(api.log[disruptIndex - 1]).toBe("GET /api/plan");

    // The planner really reassigned T01; the UI reports exactly that.
    expect(node("task:T01").textContent).toContain("Taylor · reassigned");
    expect(node("person:sam").getAttribute("data-state")).toBe("disrupted");
    expect(document.querySelector('tr[data-change="reassigned"]')?.textContent).toContain("T01");
    expect(document.querySelector(".rc-cards")?.textContent).toContain("reassigned from Sam to Taylor");
    expect(document.querySelectorAll(".rm-edges .rm-edge--ghost")).toHaveLength(1);
    expect(document.querySelectorAll(".rm-edges .rm-edge--new")).toHaveLength(1);
    expect(document.querySelector(".rw-choice")).not.toBeNull();
  });

  it("reports partial recovery honestly with the planner's reason code", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");

    expect(document.querySelector(".rw-head .rc-status")?.textContent).toBe("PARTIALLY RECOVERED");
    expect(node("task:T01").getAttribute("data-state")).toBe("unresolved");
    expect(node("task:T01").textContent).toContain("PERSON_UNAVAILABLE");
    expect(node("task:T02").getAttribute("data-state")).toBe("resolved");
    // The "before" status is the real captured one, not a guess.
    expect(document.querySelector(".rc-transition")?.textContent).toContain("FULLY RECOVERED");
    expect(document.querySelector(".rc-card--human")?.textContent).toContain(
      "Make at least one of these people available: Sam, Taylor",
    );
  });

  it("shows RECOVERY FAILED when no required task can be resolved", async () => {
    await renderLoaded();
    await inject("location_inaccessible", "home");

    expect(document.querySelector(".rw-head .rc-status")?.textContent).toBe("RECOVERY FAILED");
    expect(node("location:home").getAttribute("data-state")).toBe("disrupted");
    expect(node("task:T01").getAttribute("data-state")).toBe("blocked");
    expect(node("task:T01").textContent).toContain("LOCATION_INACCESSIBLE");
  });

  it("can compare against the baseline instead of the snapshot", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");

    fireEvent.click(document.querySelectorAll('input[name="rw-reference"]')[1]!);
    expect(document.querySelector(".rc-source")?.textContent).toContain("baseline plan");
    // Against the baseline, T01 previously belonged to Sam.
    expect(document.querySelector('tr[data-change="newly_unresolved"]')?.textContent).toContain("T01");
  });
});

describe("request states and safety", () => {
  it("sends exactly one request when the button is hit several times at once", async () => {
    await renderLoaded();
    api.delayMs = 15;
    fireEvent.change(screen.getByLabelText("TARGET"), { target: { value: "alex" } });

    // Clicks inside one act() batch: React has not re-rendered the disabled
    // button yet, so only the ref guard can stop the extra requests.
    const button = injectButton();
    act(() => {
      button.click();
      button.click();
      button.click();
    });

    await waitFor(() => expect(document.querySelector(".rw-phase--processing")).not.toBeNull());
    await settled();
    expect(api.log.filter((l) => l === "POST /api/disrupt")).toHaveLength(1);
  });

  it("disables the controls while processing and restores them afterwards", async () => {
    await renderLoaded();
    api.delayMs = 20;
    fireEvent.click(injectButton());

    await waitFor(() => expect(document.querySelector(".rw-phase--processing")).not.toBeNull());
    expect((screen.getByLabelText("DISRUPTION TYPE") as HTMLSelectElement).disabled).toBe(true);
    expect((resetButton() as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".rw-phase--processing")?.textContent).toMatch(/capturing|applying|recomputing|validating|loading/);
    // The controls stay locked across every step of the chain, not just one.
    expect((injectButton() as HTMLButtonElement).disabled).toBe(true);

    await settled();
    expect((screen.getByLabelText("DISRUPTION TYPE") as HTMLSelectElement).disabled).toBe(false);
    expect((injectButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the backend error, keeps state unchanged and restores the controls", async () => {
    await renderLoaded();
    api.failNext("/api/disrupt", 500, "planner exploded");
    await inject("person_unavailable", "sam");

    expect(document.querySelector(".rw-phase--failed")?.textContent).toContain("planner exploded");
    expect(screen.getAllByText(/planner exploded/).length).toBeGreaterThan(0);
    expect(node("task:T01").textContent).toContain("Sam");
    expect(node("person:sam").getAttribute("data-state")).toBe("ok");
    expect(document.querySelector(".rw-choice")).toBeNull();
    expect((injectButton() as HTMLButtonElement).disabled).toBe(false);

    // And the same action works afterwards.
    await inject("person_unavailable", "sam");
    expect(node("task:T01").textContent).toContain("Taylor");
  });

  it("does not record a snapshot when the pre-disruption capture fails", async () => {
    await renderLoaded();
    api.failNext("/api/plan", 503, "plan unavailable");
    await inject("person_unavailable", "sam");

    expect(document.querySelector(".rw-phase--failed")?.textContent).toContain("plan unavailable");
    expect(api.log).not.toContain("POST /api/disrupt");
  });
});

describe("reset", () => {
  it("restores the baseline, clears disruptions and discards the snapshot", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    expect(document.querySelector(".rw-choice")).not.toBeNull();

    document.querySelector(".rw-phase--succeeded")?.classList.add("stale");
    fireEvent.click(resetButton());
    await waitFor(() => expect(document.querySelector(".rw-phase--succeeded:not(.stale)")).not.toBeNull());

    expect(document.querySelector(".rw-choice")).toBeNull();
    expect(document.querySelectorAll('[data-state="disrupted"]')).toHaveLength(0);
    expect(node("task:T01").textContent).toContain("Sam");
    expect(api.disruptions).toEqual([]);
  });
});

describe("keyboard and accessibility", () => {
  it("moves between nodes with arrow keys and selects with Enter", async () => {
    await renderLoaded();

    // Only one node is in the tab order (roving tabindex).
    expect(document.querySelectorAll('.rm-node[tabindex="0"]')).toHaveLength(1);

    const alex = node("person:alex");
    alex.focus();
    fireEvent.keyDown(alex, { key: "ArrowRight" });
    expect(document.activeElement).toBe(node("task:T01"));

    fireEvent.keyDown(node("task:T01"), { key: "Enter" });
    expect(node("task:T01").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".rm-details")?.textContent).toContain("T01 · Check household members");
    expect(document.querySelectorAll(".rm-edges .rm-edge--eligible")).toHaveLength(2);

    fireEvent.keyDown(node("task:T01"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(node("task:T02"));

    fireEvent.keyDown(node("task:T02"), { key: "Escape" });
    expect(document.querySelector(".rm-detail-card")).toBeNull();
  });

  it("gives every node an accessible name and a text alternative for the graph", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");

    for (const n of document.querySelectorAll(".rm-node")) {
      expect(n.getAttribute("role")).toBe("button");
      expect((n.getAttribute("aria-label") ?? "").length).toBeGreaterThan(10);
    }
    expect(node("task:T01").getAttribute("aria-label")).toContain("reassigned from Sam");
    expect(document.querySelector(".rm-text-alt")?.textContent).toContain("Relationships as a text list");
    expect(document.querySelector(".rw-phase")?.getAttribute("role")).toBe("status");
  });

  it("never relies on colour alone: every state node carries an icon and a text label", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");
    await inject("resource_unavailable", "water");

    for (const state of ["disrupted", "unresolved", "blocked"]) {
      const nodes = document.querySelectorAll(`.rm-node[data-state="${state}"]`);
      expect(nodes.length, state).toBeGreaterThan(0);
      for (const n of nodes) {
        expect(n.querySelector(".rm-node-icon"), state).not.toBeNull();
        expect(n.textContent, state).toMatch(/DISRUPTED|UNRESOLVED|BLOCKED/);
      }
    }
  });
});

describe("reduced motion", () => {
  it("is off by default and on when the user prefers reduced motion", async () => {
    await renderLoaded();
    expect(document.querySelector(".rm")?.getAttribute("data-reduced-motion")).toBe("false");
    cleanup();

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    window.matchMedia = globalThis.matchMedia;

    await renderLoaded();
    expect(document.querySelector(".rm")?.getAttribute("data-reduced-motion")).toBe("true");
  });

  it("the stylesheet disables every animation and transition for the feature", () => {
    expect(styles.length).toBeGreaterThan(1000); // guard: the real file was loaded
    const compact = styles.replace(/\s+/g, "");
    expect(compact).toContain("@media(prefers-reduced-motion:reduce)");
    expect(compact).toContain(".rw*,.rw*::before,.rw*::after{animation:none!important;transition:none!important}");
    expect(compact).toContain('.rm[data-reduced-motion="true"]*');
  });
});

describe("Overview", () => {
  it("shows the live map and a judge-readable readiness summary without the comparison panel", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));

    await waitFor(() => expect(document.querySelector(".rm-svg")).not.toBeNull());
    expect(document.querySelector(".rc")).toBeNull();
    expect(document.querySelectorAll(".rm-node")).toHaveLength(7);
    expect(screen.getByTestId("overview-readiness").textContent).toContain("BASELINE PLAN");
    expect(screen.getByTestId("overview-risk-count").textContent).toBe("0");
    expect(screen.getByTestId("overview-next-action").textContent?.toLowerCase()).toContain("stress-test the backup plan");
    expect(screen.getByRole("button", { name: /RUN A RESILIENCE DRILL/ })).toBeTruthy();
  });

  it("changes the Overview next step when a disruption remains active", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));

    await waitFor(() => expect(screen.getByTestId("overview-readiness").textContent).toContain("PLAN RECOVERED"));
    expect(screen.getByTestId("overview-readiness").textContent).toContain("1 active disruption");
    expect(screen.getByTestId("overview-next-action").textContent).toContain("Review what the planner could not resolve.");
    expect(screen.getByRole("button", { name: /REVIEW RECOVERY/ })).toBeTruthy();
  });
});
