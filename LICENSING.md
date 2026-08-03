# Licensing

Kairo Tutor is open source under two licences, split by directory.

| Path | Licence |
| --- | --- |
| `server/` | [GNU AGPL v3.0 or later](./server/LICENSE) |
| Everything else — `src/`, `src-tauri/`, `packages/`, `tests/`, `scripts/`, `docs/` | [MIT](./LICENSE) |

Third-party components keep their own licences; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Why the split

The desktop app is the thing we want people to take, fork, learn from, and build on with as
little friction as possible. MIT asks nothing of them.

The backend is the product. It holds the provider keys, the metering, and the billing, and
running it is the business. AGPL keeps that honest in one specific way: anyone may self-host it,
modify it, and run it for themselves or their company — but someone who runs a modified version
*as a service for other people* has to publish their modifications. That is the only case the
licence is aimed at, and it is the case that would otherwise let a competitor take the work
without contributing back.

The two halves are separate programs that talk over HTTP. The AGPL's network clause binds whoever
**runs** the server; it does not reach the MIT desktop client, and it does not reach a user of
that client. `packages/shared` stays MIT deliberately, because both halves import it and MIT flows
into an AGPL codebase but not the other way around.

If the AGPL does not suit your deployment, contact the maintainers — a commercial licence for
`server/` can be discussed.

## What this means for contributors

Contributions follow the licence of the directory they land in: a change under `server/` is
contributed under AGPL-3.0-or-later, everything else under MIT. This is *inbound equals outbound* —
there is no Contributor License Agreement and you keep the copyright in what you write.

Every commit needs a `Signed-off-by:` trailer (`git commit -s`), which is checked by CI. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Relicensing consent

`server/` was MIT-licensed before this change, and it contains work by more than one copyright
holder. Relicensing is not something a repository owner can do unilaterally over someone else's
code, so it is recorded here instead of assumed.

Relicensing applies from this commit forward. Earlier commits remain available under MIT, and
anyone who obtained the code under MIT keeps those rights to that snapshot — that is how
relicensing works everywhere and is not something this document changes.

The copyright holders below have each agreed to license their existing contributions under
`server/` as AGPL-3.0-or-later:

| Copyright holder | Consent recorded |
| --- | --- |
| Prasad Sankar (@Prasad-178) | _pending_ |
| Vaibhav Pandey (@vaibhav0806) | _pending_ |

Consent is recorded as a comment on the pull request that introduces this file, from the
copyright holder's own account. This table is updated to link that comment before the pull
request is merged.
