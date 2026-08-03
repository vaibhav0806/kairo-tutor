# Contributing to Kairo Tutor

Thanks for helping improve Kairo Tutor. This project welcomes bug reports, feature ideas,
documentation improvements, tests, and code contributions.

## Before You Start

- Read the [README](./README.md) for supported platforms, prerequisites, architecture, local
  setup, and current commands.
- Search existing issues and pull requests before opening a duplicate.
- For a substantial feature or architectural change, open a feature request first so the
  approach can be discussed before implementation.
- Do not use a public issue for a security vulnerability. Follow [SECURITY.md](./SECURITY.md).

## Development Workflow

1. Fork the repository and create a focused branch from the latest `main`.
2. Install and configure the project as described in the README. Never commit `.env` files,
   credentials, recordings, screenshots, transcripts, or other private user data.
3. Make one cohesive change. Match the existing style and avoid unrelated refactors.
4. Add or update tests for behavior changes.
5. Run the relevant checks documented in the README. For changes spanning the desktop and
   server, run both packages' checks.
6. Open a pull request using the repository template. Explain the problem, the chosen solution,
   how it was tested, and any privacy or security impact.

Small pull requests are easier to review. A maintainer may ask that a large change be split into
separate pull requests.

## Contribution Requirements

- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Keep provider keys and backend secrets out of the desktop bundle, source code, fixtures, logs,
  and pull-request descriptions.
- Treat screen captures, audio, transcripts, questions, answers, email addresses, and account or
  billing data as sensitive. Use synthetic data in tests and documentation.
- Preserve the project's privacy-first defaults. A feature that sends data to an external service
  must be clearly disclosed and should minimize what is sent.
- Keep macOS-only code behind the existing platform boundaries where practical.
- Update user-facing or contributor documentation when behavior, setup, commands, permissions, or
  external data flows change.

## Reporting Problems

Use the issue forms for reproducible bugs and feature requests. General usage questions belong in
the support channels listed in [SUPPORT.md](./SUPPORT.md). Report vulnerabilities privately as
described in [SECURITY.md](./SECURITY.md).

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by:` trailer. It is checked by CI, and it is the only
paperwork this project asks for.

```bash
git commit -s          # adds the trailer for you
```

The trailer certifies the [Developer Certificate of Origin](https://developercertificate.org):
that you wrote the change, or otherwise have the right to submit it under this project's licence.
It is **not** a copyright assignment — you keep the copyright in what you write, and the
maintainers get nothing beyond the inbound licence below.

Forgot on commits you already pushed:

```bash
git rebase --signoff origin/main
git push --force-with-lease
```

## License and CLA

Kairo Tutor is licensed under the [MIT License](./LICENSE). No Contributor License Agreement is
required. By submitting a contribution, you agree that your contribution is provided under the
same MIT License that covers this repository (inbound equals outbound), and that you have the
right to submit it.
