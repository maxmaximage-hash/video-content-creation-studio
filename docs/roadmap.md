# Roadmap

This roadmap records accepted product directions that are not yet part of the stable desktop release. Every item must preserve the single Library model and must be validated in the real installed app before release.

## Mobile Link Capture

Goal: users can save links while browsing content at the office, at home, or outside. The mobile entry must not depend on being on the same Wi-Fi as the desktop Mac.

Accepted constraints:

- Mobile and desktop submissions enter the same Inspirations library.
- A mobile link creates the same inspiration card shape as a desktop link.
- There is no separate asset model for mobile content.
- A mobile link inbox may exist as a workflow view for pending or failed submissions, but it must point to the same underlying content records.
- The capture pipeline should auto-fetch when possible and keep retry state when login, platform throttling, or network conditions block completion.

Likely architecture:

- Add a small authenticated remote submission endpoint rather than a LAN-only QR page.
- Store submitted URLs as pending capture tasks with source metadata such as `source: mobile`.
- Run platform extraction through the existing platform adapters and scheduler.
- Use the same `canonicalSourceKey` de-duplication as desktop capture so the same work does not create duplicate cards.
- Keep media in the selected Library and store only relative asset paths in records.

Open decisions before implementation:

- Account model: personal token, team login, or another authenticated access method.
- Hosting target: self-hosted service, cloud function, or a future built-in collaboration service.
- Offline behavior: whether mobile submissions queue locally on the phone before reaching the service.
- Permission model for team members who can submit links but should not edit the whole Library.

## Multi-Platform Capture Expansion

Goal: reuse the useful collector capabilities from `zzzzzc946-hub/chen-content-collector` without importing its Library model or unrelated UI.

Scope to extract:

- Platform-specific content metadata capture.
- Homepage/profile scanning.
- Batch capture task tracking.
- Failure retry and resume.
- Transcript acquisition.

Integration rules:

- Every platform adapter must return the same normalized inspiration payload.
- Platform-specific fallbacks live inside the adapter, not in page components.
- A batch scan must create at most one card per stable platform content key.
- Platform interaction data such as likes, comments, shares, favorites, publish time, author and account ID should be stored as snapshot metadata with a `capturedAt` timestamp.
- Existing local media is never downgraded to unrecognized just because a later online refresh fails.

## Transcription Priority

Goal: get transcripts quickly while controlling cost.

Priority order:

1. Platform-provided captions or transcripts.
2. Cloud transcription with monthly free quota.
3. Local transcription runtime.

Requirements:

- API keys must be stored in macOS Keychain or an equivalent local secret store.
- Quota status and fallback reason should be visible in the app.
- When quota is exhausted or cloud calls fail, local transcription should continue the task instead of failing the whole capture.
