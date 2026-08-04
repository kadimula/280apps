# Security Policy

280 owns deploys, identity, sharing, and permissions for people who cannot audit those themselves. Security reports get priority over all other work.

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Preferred: [report privately via GitHub](https://github.com/kadimula/280apps/security/advisories/new)
- Or email: [kishore@kadimula.com](mailto:kishore@kadimula.com)

Include what you found, where (file, endpoint, or URL), and steps to reproduce if you have them. You will get an acknowledgment within two business days, and a status update once the report is triaged.

## Scope

- The platform code in this repository: backend, gateway, CLI, contracts, sdk, egress, and the app container harness
- The hosted service at 280apps.com and apps served on 280apps.run

Please test only against apps and data you own. Do not run automated scanners against the hosted service, attempt to access other users' apps or data, or degrade the service for others.
