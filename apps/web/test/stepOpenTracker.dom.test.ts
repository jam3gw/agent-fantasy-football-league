// @vitest-environment happy-dom
/**
 * The step-open click handler against the real card structure: a step card is
 * a `<details data-step-card>` whose body holds nested `<details>` disclosures
 * for tool arguments. Only a click on the step card's own summary, while it is
 * closed, is a reader opening a step.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));

import { track } from "@vercel/analytics";
import { onDocumentClick } from "@/components/step-open-tracker";

function mount(open: boolean): { stepSummary: HTMLElement; nestedSummary: HTMLElement } {
  document.body.innerHTML = `
    <details data-step-card data-step-kind="decision" ${open ? "open" : ""}>
      <summary><span id="step-title">Step 3</span></summary>
      <div>
        <details>
          <summary><span id="nested-title">arguments</span></summary>
          <pre>{}</pre>
        </details>
      </div>
    </details>`;
  return {
    stepSummary: document.getElementById("step-title")!,
    nestedSummary: document.getElementById("nested-title")!,
  };
}

/** Dispatch a real click so `e.target` is the element, as in the browser. */
function click(el: HTMLElement | HTMLElement["ownerDocument"]["body"]): void {
  document.addEventListener("click", onDocumentClick, true);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  document.removeEventListener("click", onDocumentClick, true);
}

describe("step-open click handler", () => {
  beforeEach(() => vi.mocked(track).mockClear());

  it("counts a click inside a closed step card's summary, with its kind", () => {
    const { stepSummary } = mount(false);
    click(stepSummary);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("Step opened", { page: "/", kind: "decision" });
  });

  it("ignores a click that closes an open card", () => {
    const { stepSummary } = mount(true);
    click(stepSummary);
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores a nested disclosure's summary inside the card", () => {
    const { nestedSummary } = mount(false);
    click(nestedSummary);
    expect(track).not.toHaveBeenCalled();
  });

  it("ignores a click outside any summary", () => {
    mount(false);
    click(document.body);
    expect(track).not.toHaveBeenCalled();
  });
});
