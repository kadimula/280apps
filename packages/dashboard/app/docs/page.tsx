import type { Metadata } from "next";

import { InstallCommand } from "@/components/install-command";
import { SiteHeader } from "@/components/site-header";
import { fetchCapabilities, type DocsCapabilities } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Docs | 280",
  description: "280 CLI reference.",
};

// The support matrix is owned by the platform now; this page fetches it as JSON
// and renders the same table it always has. Dynamic so a build with no platform
// reachable (CI) does not try to prerender it; the underlying fetch is cached
// (revalidate in lib/docs) so the render stays cheap at request time.
export const dynamic = "force-dynamic";

// Mirrors `280 help` from the `two80` CLI. The CLI is the source of truth; if a
// flag changes there, change it here. Run any command via
// `npx -y two80@latest <command>` (Node 20+, nothing to install).
const COMMANDS = [
  {
    name: "280 push",
    body: "Build identity, deploy, print the live URL. Runs init if new.",
    flags: [
      ["--name <slug>", "app name on first init (default: package.json name)"],
      ["--framework next|static", "skip detection on first init"],
      ["--new", "force a fresh app instead of linking an existing one"],
    ],
  },
  {
    name: "280 init",
    body: "Detect framework, write .280/config.json. Push does this for you.",
    flags: [
      ["--name <slug>", "app name (default: package.json name)"],
      ["--framework next|static", "skip detection"],
    ],
  },
  { name: "280 whoami", body: "Print auth state.", flags: [] },
  {
    name: "280 login",
    body: "Authenticate this machine. Prints a link to show your user, then re-run to finish. Never waits.",
    flags: [],
  },
  { name: "280 version", body: "Print the CLI version.", flags: [] },
  { name: "280 help", body: "Print every command and flag.", flags: [] },
];

// Feature names and notes come from the backend as markdown, so a `backtick`
// span is code. Render those as <code> here instead of leaking literal backticks
// into the styled table. The code inherits size and color, so it fits either cell.
function Inline({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-[0.92em] text-[var(--color-ink)]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14">
      <h2 className="font-display text-[1.6rem] leading-tight text-[var(--color-ink)]">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

// loadCapabilities returns null when the platform could not be reached, which
// the matrix section renders as a short unavailable note rather than an empty
// table that reads as "280 supports nothing".
async function loadCapabilities(): Promise<DocsCapabilities | null> {
  try {
    return await fetchCapabilities();
  } catch {
    return null;
  }
}

export default async function Docs() {
  const caps = await loadCapabilities();

  return (
    <div className="relative flex flex-1 flex-col">
      <div
        aria-hidden
        className="gold-breathe pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(90%_100%_at_50%_0%,rgba(212,175,55,0.13),rgba(212,175,55,0)_62%)]"
      />

      <SiteHeader>
        <a href="/login" className="transition-colors hover:text-[var(--color-ink)]">
          Sign in
        </a>
      </SiteHeader>

      <main className="relative z-10 mx-auto w-full max-w-3xl flex-1 px-6 pt-10 pb-24">
        <h1 className="font-display text-[clamp(2.25rem,5vw,3.25rem)] leading-[1.05] tracking-[-0.02em] text-[var(--color-ink)]">
          Docs
        </h1>


        <p className="mt-6 text-[17px] leading-[1.7] text-[var(--color-body)]">
          280 is a platform which helps humans and agents build secure, internal apps. Professionals across every single domain now have access to
          AI coding tools, and can quickly vibecode useful protypes for their team.
        </p>

        <p className="mt-6 text-[17px] leading-[1.7] text-[var(--color-body)]">
          But anyone building in sensitive domains like finance and health knows, that auth and permissions
            get complicated fast. They are the difference between a system your team can trust, and one that
            leaks sensitive data and creates constant internal headaches. Worse, agents rewrite this risky
            security code from scratch every time, and non-technical teammates have no easy way to review,
            adjust, or manage who can access what.
        </p>

        <p className="mt-6 text-[17px] leading-[1.7] text-[var(--color-body)]">
          This is where 280 comes in. The platform is built agent first, with tools out of the box that let
            agents deploy, authorize, and permission users at the feature and data level. The human keeps
            directing features as usual, and can add, edit, and remove fine-grained permissions and secrets in seconds.
        </p>


        <Section title="Ask your agent">
          <InstallCommand prompt="Fetch 280apps.com/setup.md and push" />
        </Section>

        <Section title="CLI">
          <p className="text-[14px] leading-[1.65] text-[var(--color-muted)]">
            For direct control. Every error prints a{" "}
            <code className="font-mono text-[13px] text-[var(--color-ink)]">
              fix
            </code>{" "}
            line with the exact command to run next.
          </p>

          <div className="mt-5 divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]">
            {COMMANDS.map((cmd) => (
              <div key={cmd.name} className="px-5 py-4">
                <code className="font-mono text-[13px] font-medium text-[var(--color-ink)]">
                  {cmd.name}
                </code>
                <p className="mt-1.5 text-[13px] leading-[1.6] text-[var(--color-body)]">
                  {cmd.body}
                </p>
                {cmd.flags.length > 0 && (
                  <dl className="mt-3 space-y-1.5 border-l border-[var(--color-line)] pl-4">
                    {cmd.flags.map(([flag, desc]) => (
                      <div
                        key={flag}
                        className="flex flex-col gap-0.5 sm:flex-row sm:gap-5"
                      >
                        <dt className="font-mono text-[12px] text-[var(--color-gold-600)] sm:w-[210px] sm:shrink-0">
                          {flag}
                        </dt>
                        <dd className="text-[12px] leading-[1.6] text-[var(--color-muted)]">
                          {desc}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Currently supported">
          <p className="text-[14px] leading-[1.65] text-[var(--color-muted)]">
            Which stacks, runtime features, and platform capabilities work
            through a push today.
          </p>
          {caps === null ? (
            <p className="mt-5 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] px-5 py-4 text-[13px] leading-[1.6] text-[var(--color-muted)]">
              The support matrix is temporarily unavailable. Try again shortly.
            </p>
          ) : (
            <>
          <div className="mt-5 overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]">
            <table className="w-full border-collapse text-left align-top">
              <thead>
                <tr className="border-b border-[var(--color-line)]">
                  <th className="px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Stack
                  </th>
                  <th className="px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Feature
                  </th>
                  <th className="px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Supported
                  </th>
                  <th className="px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {caps.matrix.map((group, gi) =>
                  group.features.map((feature, fi) => (
                    <tr
                      key={group.name + feature.name}
                      className={
                        fi === 0 && gi > 0
                          ? "border-t border-[var(--color-line)]"
                          : fi > 0
                            ? "border-t border-[var(--color-line)]/60"
                            : undefined
                      }
                    >
                      {fi === 0 && (
                        <th
                          scope="rowgroup"
                          rowSpan={group.features.length}
                          className="border-r border-[var(--color-line)] px-5 py-3.5 align-top text-[14px] font-medium text-[var(--color-ink)]"
                        >
                          {group.name}
                        </th>
                      )}
                      <td className="px-5 py-3.5 text-[14px] leading-[1.5] text-[var(--color-body)]">
                        <Inline text={feature.name} />
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        {feature.status === "supported" ? (
                          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-gold-600)]">
                            <span aria-hidden className="font-mono">
                              ✓
                            </span>
                            Yes
                          </span>
                        ) : (
                          <span className="text-[13px] text-[var(--color-muted)]">
                            No
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 align-top text-[12px] leading-[1.5] text-[var(--color-muted)]">
                        <Inline text={feature.note} />
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] leading-[1.6] text-[var(--color-muted)]">
            {caps.requirement}
          </p>
            </>
          )}
        </Section>
      </main>

      <footer className="relative z-10 border-t border-[var(--color-line)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-8 text-[13px] text-[var(--color-muted)]">
          <span className="font-display text-lg font-semibold leading-none text-[var(--color-ink)]">
            280
          </span>
        </div>
      </footer>
    </div>
  );
}
