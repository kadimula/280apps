# Self-hosting 280

The source is open under the [FSL](LICENSE.md) so you can audit exactly what runs and secures your apps. The license grants you the right to run 280 yourself. Running your own instance requires your own Cloudflare, Depot, and Postgres accounts and is currently **unsupported**. The managed service at [280apps.com](https://www.280apps.com) is the recommended path.

## What self-hosting takes today

There is no compose file, installer, or runbook. A working instance needs, at minimum:

- A Cloudflare account with Workers Paid, Containers, Durable Objects, Hyperdrive, and R2
- A Depot account and token for container builds
- A Postgres database
- Your own OAuth apps for sign-in
- Your own domain and DNS zone

Every environment variable the backend and gateway read is documented in `.env.example` (names and shapes only). Beyond that, you are on your own: self-hosting questions in issues may be closed without support.

## Why this stance

280 exists so that non-technical teams never have to debug deploys, configure auth, or reason about security. The code is open first for **security transparency**: anyone can verify what actually runs and how identity, sharing, and permissions are enforced. Making self-hosting turnkey is not a current goal. If that changes, this document will say so.
