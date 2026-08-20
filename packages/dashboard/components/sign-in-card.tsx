// The one sign-in surface. /login and /activate differ only in where they send
// you afterward, which the caller passes as `redirect`. Login moved to the
// backend, so each provider is a plain link into that flow rather than a form:
// the app holds no credentials and no auth logic.

import { loginHref, type LoginProvider } from "@/lib/session";

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.46h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.72Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.77l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.87 8.88 4.75 12 4.75Z"
      />
    </svg>
  );
}

function MicrosoftMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

const PROVIDERS: {
  name: LoginProvider;
  label: string;
  Mark: (props: { className?: string }) => React.ReactElement;
}[] = [
  { name: "google", label: "Continue with Google", Mark: GoogleMark },
  { name: "microsoft", label: "Continue with Microsoft", Mark: MicrosoftMark },
];

export function SignInCard({
  redirect,
  error,
  heading,
  subheading,
}: {
  redirect: string;
  error?: string;
  heading?: string;
  subheading?: string;
}) {
  return (
    <div className="w-full max-w-sm rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper)] px-8 py-10 text-center shadow-[0_1px_2px_rgba(10,10,10,0.04)]">
      <h1 className="font-display text-[2rem] leading-tight text-[var(--color-ink)]">
        {heading ?? "Sign in"}
      </h1>
      <p className="mt-3 text-[14px] leading-[1.6] text-[var(--color-body)]">
        {subheading ?? ""}
      </p>

      <div className="mt-7 flex flex-col gap-2">
        {PROVIDERS.map(({ name, label, Mark }) => (
          <a
            key={name}
            href={loginHref(redirect, name)}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-4 py-3 text-[14px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-paper-warm)]"
          >
            <Mark className="h-[18px] w-[18px]" />
            {label}
          </a>
        ))}
      </div>

      {error ? (
        <p className="mt-4 text-[13px] leading-[1.6] text-[#b4342b]">
          Sign-in did not complete. Try again.
        </p>
      ) : null}
    </div>
  );
}
