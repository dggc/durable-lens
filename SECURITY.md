# Security policy

durable-lens reads stores that hold prompts, tool output and model answers, and it serves them on a local port. Security reports are taken seriously.

## Supported versions

The latest 0.x minor release gets security fixes. Until 1.0, older minors do not. Update to the latest release before reporting, if you can.

| Version | Supported |
|---|---|
| Latest 0.x minor | yes |
| Older releases | no |

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting: <https://github.com/dggc/durable-lens/security/advisories/new>.

Do not open a public issue, a pull request or a discussion for a vulnerability. Do not attach a real store, transcript or `--json` output to a report. A small synthetic store that triggers the problem is better, and a fixture from this repository is best.

Please include:

- the durable-lens version (`durable-lens --version`), or the commit if you run a clone, the Node.js version and the operating system;
- the pi-durable version and storage kind (SQLite or JSONL) involved, if it matters;
- what you expected, what happened, and why you think it is a vulnerability;
- steps to reproduce, or a proof of concept, using synthetic data;
- the impact you see, and who would be affected.

## What to expect

durable-lens has one maintainer. Responses are best effort. You can expect an acknowledgement within 7 days. After that, the maintainer will confirm or dispute the report, tell you how it will be handled, and credit you in the advisory if you want that. There is no bug bounty.

Please give a reasonable time to ship a fix before you publish details. Fixes are released as a new version, with a GitHub security advisory and a note in the [CHANGELOG](CHANGELOG.md).

## Scope

In scope:

- anything that makes durable-lens write to a store, or create or change a file next to it;
- anything that exposes store content beyond the loopback interface, or to another local user;
- anything that executes store content, in the server or in the page, including through crafted Markdown, JSON, file names, or document or task content;
- anything that bypasses the access token, the `Host` check or the Content-Security-Policy;
- anything that leaves a snapshot copy of a SQLite store behind, or makes it readable by others;
- a vulnerability in a file that is published in the npm package.

Out of scope:

- the user's own decoder module. It is code that the user chooses to run, with the user's permissions, and it reads its own keys;
- an attack that already needs the same local user, or root, on the machine where durable-lens runs: reading the user's files, the process memory or the terminal output;
- a store written by a malicious pi-durable harness that only makes durable-lens slow or use a lot of memory. The whole store is read into memory, as documented under Limits in the [README](README.md). A report of a small input that exhausts memory or time in a way that is out of proportion is welcome;
- findings in the pi-durable packages themselves. Report those to their maintainers;
- vulnerabilities that exist only in development tooling and do not reach the published package.

## More

[docs/security-model.md](docs/security-model.md) describes the threats that durable-lens considers and how each is handled.
