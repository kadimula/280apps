// The OAuth popup lands here after the backend callback. It only exists to hand
// the outcome back to the dashboard that opened it and close itself; the parent
// window does the catalog refresh. Rendered as an inline script so it runs during
// parse, before any dashboard chrome paints.

export const metadata = { robots: { index: false, follow: false } };

export default async function OAuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ integration_error?: string }>;
}) {
  const { integration_error } = await searchParams;
  const ok = integration_error !== "oauth";
  const script = `(function(){try{window.opener&&window.opener.postMessage({type:"280-oauth-complete",ok:${ok}},window.location.origin);}catch(e){}window.close();})();`;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-paper)] px-6 text-center">
      <p className="text-[14px] text-[var(--color-body)]">
        You can close this window.
      </p>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </main>
  );
}
