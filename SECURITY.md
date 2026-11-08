# Security reports

Use this repository's **Security → Advisories → Report a vulnerability** channel
when private reporting is enabled. If that channel is unavailable, request a
private contact without including sensitive details in a public issue. This file
does not designate a personal email address or an external support service.

Include the affected version, a minimal reproduction using synthetic data, the
expected authorization boundary and the observed behavior. Remove credentials,
tokens, private conversations, screenshots of personal accounts and real runtime
configuration from the report.

The product and operations listeners use independent API surfaces, origins and
session purposes. A team owner is not a platform operator. Workspace identifiers
are explicit in product APIs, and mutation requests bind the expected account.
Execution workers receive the scope and credentials for their permitted operation;
they do not inherit ambient model credentials.

Deployment configuration, models, OAuth grants and user data belong in ignored
private files and data directories. HTTPS, reverse-proxy configuration, operating
system permissions and third-party account authorization are deployment concerns.
The repository's source and privacy checks supplement, rather than replace, review
of the actual files selected for publication.
