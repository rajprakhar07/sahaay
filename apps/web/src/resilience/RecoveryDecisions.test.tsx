import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockApi, type MockApi } from "../test-utils/mockApi";

// These tests drive the real UI against the real engine (via the mock API,
// which calls `recoverPlan`); nothing about the planner's behaviour is stubbed.

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

const node = (key: string) => document.querySelector(`[data-node="${key}"]`);
const rd = () => document.querySelector(".rd") as HTMLElement;
const step = (name: string) => rd().querySelector(`[data-step="${name}"]`) as HTMLElement;
const decision = (taskId: string) => rd().querySelector(`[data-task="${taskId}"]`) as HTMLElement | null;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

async function renderLoaded() {
  render(<App />);
  await waitFor(() => expect(node("task:T01")).not.toBeNull());
}

async function inject(type: string, target: string) {
  fireEvent.change(screen.getByLabelText("DISRUPTION TYPE"), { target: { value: type } });
  fireEvent.change(screen.getByLabelText("TARGET"), { target: { value: target } });
  document.querySelector(".rw-phase--succeeded, .rw-phase--failed")?.classList.add("stale");
  fireEvent.click(screen.getByRole("button", { name: /INJECT DISRUPTION|WORKING/ }));
  await waitFor(() =>
    expect(document.querySelector(".rw-phase--succeeded:not(.stale), .rw-phase--failed:not(.stale)")).not.toBeNull(),
  );
}

describe("decision trace in the Chaos Lab", () => {
  it("is labelled as simulated and shows the five stages in order, even for the baseline", async () => {
    await renderLoaded();

    expect(text(rd())).toContain("SIMULATED SCENARIO · FICTIONAL HOUSEHOLD");
    expect(text(rd())).toContain("not real emergency data");
    expect([...rd().querySelectorAll("[data-step]")].map((e) => e.getAttribute("data-step"))).toEqual([
      "disruption",
      "affected",
      "action",
      "validation",
      "risks",
    ]);

    expect(text(step("disruption"))).toContain("No disruption is active, so this is the baseline plan");
    expect(text(step("affected"))).toContain("Nothing is affected");
    expect(text(step("action"))).toContain("Nothing to recover");
    expect(text(step("validation"))).toContain("PASSED");
    expect(text(step("validation"))).toContain("checked 2 of 2 tasks");
    expect(text(step("risks"))).toContain("No unresolved tasks");
  });

  it("derives baseline insights from the real plan", async () => {
    await renderLoaded();
    const metric = (name: string) => text(rd().querySelector(`[data-metric="${name}"]`));

    expect(metric("required")).toBe("2 of 2");
    expect(metric("affected")).toBe("0 of 2");
    expect(metric("open")).toBe("0");
    expect(text(screen.getByTestId("bottlenecks"))).toContain("No single-holder skill");
    // Alex does T02 (20 min), Sam does T01 (10 min): 67% and 33% of 30.
    expect(text(screen.getByTestId("workload"))).toContain("Alex: 20 min · 67% of scheduled time (T02)");
    expect(text(screen.getByTestId("workload"))).toContain("Sam: 10 min · 33% of scheduled time (T01)");
  });

  it("explains a real reassignment: what happened, why Taylor, who else was considered", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");

    expect(text(step("disruption"))).toContain("Sam is unavailable.NEW");
    expect(text(step("affected"))).toContain("T01 Check household members");
    expect(text(step("affected"))).toContain("Was assigned to Sam, who is unavailable.");

    const t01 = decision("T01")!;
    expect(t01).not.toBeNull();
    expect(text(t01.querySelector("summary"))).toContain("Reassigned from Sam to Taylor");
    expect(text(t01)).toContain("Taylor is the only available person");
    expect(text(t01)).toContain("Sam is unavailable in this scenario");

    const verdict = (person: string) =>
      text([...t01.querySelectorAll(".rd-cands li")].find((li) => li.textContent?.includes(person)) ?? null);
    expect(verdict("Alex")).toContain("LACKS SKILL");
    expect(verdict("Sam")).toContain("DISRUPTED");
    expect(verdict("Taylor")).toContain("SELECTED");
    expect(text(t01)).toContain("Needs communication: Taylor has it.");
    // Only affected or changed tasks get a decision; T02 was untouched.
    expect(decision("T02")).toBeNull();

    expect(text(step("validation"))).toContain("PASSED");
    expect(text(step("risks"))).toContain("No unresolved tasks");
    expect(text(screen.getByTestId("bottlenecks"))).toContain("Only Taylor can provide communication");
    expect(text(screen.getByTestId("workload"))).toContain("Taylor: 10 min");
  });

  it("shows at-a-glance comparison counts that match the plan", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    const count = (name: string) => text(document.querySelector(`.rc-glance [data-count="${name}"]`));

    expect(count("reassigned")).toBe("1 reassigned");
    expect(count("recovered")).toBe("0 recovered");
    expect(count("newly-failed")).toBe("0 newly failed");
    expect(count("unresolved")).toBe("0 unresolved now");
    expect(document.querySelector('[data-testid="incomplete-reasons"]')).toBeNull();
  });

  it("is honest about incomplete recovery: why, who else could not help, what to do", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");

    expect(document.querySelector(".rw-head .rc-status")?.textContent).toBe("PARTIALLY RECOVERED");

    const t01 = decision("T01")!;
    expect(text(t01.querySelector("summary"))).toContain("Could not be recovered");
    expect(text(t01)).toContain("Why it could not be recovered");
    expect(text(t01)).toContain("Why nobody else could take it");
    const verdicts = [...t01.querySelectorAll(".rd-cands li")].map((li) => li.getAttribute("data-verdict"));
    expect(verdicts).toEqual(["missing_skills", "disrupted", "disrupted"]);
    expect(text(t01)).toContain("To make it feasible: Make at least one of these people available: Sam, Taylor.");
    expect(t01.querySelector(".rd-tag--selected")).toBeNull();

    // Validation passed for what was scheduled, and the panel says so without overclaiming.
    expect(text(step("validation"))).toContain("PASSED");
    expect(text(step("validation"))).toContain("checked 1 of 2 tasks");
    expect(text(step("validation"))).toContain("does not mean the remaining tasks are handled");
    expect(text(step("risks"))).toContain("T01 Check household members (required): Person unavailable");

    expect(text(screen.getByTestId("incomplete-reasons"))).toContain("Person unavailable (T01)");
    expect(text(screen.getByTestId("bottlenecks"))).toContain("No available person has communication");
    expect(text(rd().querySelector('[data-metric="required"]'))).toBe("1 of 2");
    expect(text(document.querySelector('.rc-glance [data-count="newly-failed"]'))).toBe("1 newly failed");
  });

  it("explains a resource block with the failed constraint and no invented alternatives", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");
    await inject("resource_unavailable", "water");

    expect(document.querySelector(".rw-head .rc-status")?.textContent).toBe("RECOVERY FAILED");
    const t02 = decision("T02")!;
    expect(text(t02)).toContain("Needs Water kit (1 kit): unavailable in this scenario.");
    expect(t02.querySelector('.rd-constraints [data-met="false"]')).not.toBeNull();
    expect(text(t02)).not.toContain("Why nobody else could take it");
    expect(text(screen.getByTestId("bottlenecks"))).toContain("Water kit: unavailable");
    expect(text(screen.getByTestId("bottlenecks"))).toContain("not resolved: T02");
  });

  it("re-explains against the baseline when that comparison is chosen", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");

    // Against the pre-disruption snapshot only Taylor is new.
    expect(text(step("disruption"))).toContain("Taylor is unavailable.NEW");
    expect(text(step("disruption"))).not.toContain("Sam is unavailable.NEW");

    fireEvent.click(document.querySelectorAll('input[name="rw-reference"]')[1]!);
    // Against the baseline both disruptions are new, and T01 changed from Sam.
    expect(text(step("disruption"))).toContain("Sam is unavailable.NEW");
    expect(text(step("disruption"))).toContain("Taylor is unavailable.NEW");
    expect(decision("T01")).not.toBeNull();
    expect(text(document.querySelector('.rc-glance [data-count="newly-failed"]'))).toBe("1 newly failed");
  });

  it("does not duplicate panels or decisions after repeated disruptions", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");
    await inject("resource_unavailable", "water");

    expect(document.querySelectorAll(".rd")).toHaveLength(1);
    expect(document.querySelectorAll(".rc")).toHaveLength(1);
    expect(rd().querySelectorAll('[data-task="T01"]')).toHaveLength(1);
    expect(rd().querySelectorAll('[data-task="T02"]')).toHaveLength(1);
    expect(rd().querySelectorAll(".rd-step")).toHaveLength(5);
    // The map and its selections still work alongside the new panel.
    expect(document.querySelectorAll(".rm-node")).toHaveLength(7);
  });

  it("every status in the trace carries text, not colour alone", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    await inject("person_unavailable", "taylor");

    for (const tag of rd().querySelectorAll(".rd-tag")) {
      expect((tag.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    for (const item of rd().querySelectorAll("[data-met]")) {
      expect(item.textContent).toMatch(/MET|NOT MET/);
    }
  });
});

describe("where the trace appears", () => {
  it("is absent from the Overview, which keeps showing only the live map", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    await waitFor(() => expect(document.querySelector(".rm-svg")).not.toBeNull());
    expect(document.querySelector(".rd")).toBeNull();
    expect(document.querySelector(".rc")).toBeNull();
  });

  it("returns to the baseline explanation after a reset", async () => {
    await renderLoaded();
    await inject("person_unavailable", "sam");
    expect(decision("T01")).not.toBeNull();

    document.querySelector(".rw-phase--succeeded")?.classList.add("stale");
    fireEvent.click(screen.getByRole("button", { name: /RESET/ }));
    await waitFor(() => expect(document.querySelector(".rw-phase--succeeded:not(.stale)")).not.toBeNull());

    expect(decision("T01")).toBeNull();
    expect(text(step("disruption"))).toContain("No disruption is active");
    expect(text(rd().querySelector('[data-metric="required"]'))).toBe("2 of 2");
  });

  it("does not render a trace, or crash, when planner data is missing", async () => {
    api.failNext("/api/plan", 500, "planner offline");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toMatch(/planner offline|not available/i));
    expect(document.querySelector(".rd")).toBeNull();
  });
});
