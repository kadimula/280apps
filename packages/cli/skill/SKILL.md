---
name: 280-deploy
description: Deploy and share a local web app (Next.js or static) to a live URL with one command. Use when the user wants to deploy, publish, ship, or share an app or prototype and get a link.
---

# 280: deploy and share

Deploy and share your app with one command. 280 turns a local app into a live, shareable URL. One verb does
everything: build, upload, and print the link. Run it via `npx` so no install
is needed.

## Deploy

```sh
npx -y two80@latest push
```

- Runs from the app's directory. Auto-detects Next.js or static; no config needed.
- First push starts a device login: it prints a link and a code, then exits. Give
  the link to the user to approve, then run `push` again to finish and deploy.
- Reports the live URL on success. Re-run `push` to redeploy.

## Other commands

```sh
npx -y two80@latest            # this directory's app state and next steps
npx -y two80@latest whoami     # auth state
npx -y two80@latest login      # authenticate this machine (prints a link)
npx -y two80@latest delete --yes <name>   # destroy the app: URL, content, data
```

## Notes

- Output is agent-readable (TOON on stdout). Errors carry a runnable fix.
- Exit codes: 0 ok, 1 failure (with a fix), 2 bad flags or args.
- Ambient state at session start: run `npx -y two80@latest setup` once to register
  a hook that shows this directory's app state when a session opens.
