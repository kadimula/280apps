import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VariablesDialog } from "@/components/variables-dialog";

// Regression for the ?variables=1 deep-link SSR crash: when autoOpen seeded the
// open state, the portal branch dereferenced document.body during server render
// (document is undefined) and threw ReferenceError at render time. The dialog
// must now stay closed through SSR and open only from a client effect.
describe("VariablesDialog server rendering", () => {
  const app = { id: "app_1af8df68e0f6", slug: "sheets-todo" };

  it("renders with autoOpen without throwing", () => {
    expect(() =>
      renderToStaticMarkup(<VariablesDialog app={app} autoOpen />),
    ).not.toThrow();
  });

  it("does not emit the portal dialog during SSR", () => {
    const html = renderToStaticMarkup(<VariablesDialog app={app} autoOpen />);
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Variables");
  });
});
