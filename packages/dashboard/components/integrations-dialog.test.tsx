import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { IntegrationsDialog } from "@/components/integrations-dialog";

// The dialog opens on ?integrations=1 after the OAuth redirect. As with the
// Variables dialog, autoOpen must not seed the open state during SSR: the portal
// branch dereferences document.body, which is undefined on the server. The dialog
// stays closed through SSR and opens only from a client effect.
describe("IntegrationsDialog server rendering", () => {
  const app = { id: "app_1af8df68e0f6", slug: "sheets-todo" };

  it("renders with autoOpen without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
      ),
    ).not.toThrow();
  });

  it("does not emit the portal dialog during SSR", () => {
    const html = renderToStaticMarkup(
      <IntegrationsDialog app={app} apiBase="" mock autoOpen />,
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Integrations");
  });
});
