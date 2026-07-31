# Asset Provenance

This maintainer ledger records where committed binary and brand assets came from. A file's presence
in this MIT-licensed repository is not, by itself, evidence that Kairo contributors own it or may
relicense it.

`Unresolved` rows must be supported by source records, written permission, or replacement assets
before broad public promotion.

| Asset | Known origin and evidence | Status / required action |
| --- | --- | --- |
| `assets/brand/kairo-mark-source-1024.png` | Byte-identical to `prasad-178/kairo/public/brand/kairo-mark-transparent-1024.png` (SHA-256 `8e059ce18a6b03a67342249e5541db3e383a3df5b17a7dd6d2c5ed38c99600e4`). Imported in commit `1ae5528`; [`scripts/brand/README.md`](../scripts/brand/README.md) records the path. | **Unresolved:** record the original mark's creator/rightsholder and ownership or license evidence. The landing repository is a transfer record, not proof of ownership. |
| `public/brand/kairo-mark.svg`, `assets/brand/kairo-mark-mono.svg`, `assets/brand/kairo-icon-1024.png`, `assets/brand/dmg-background.png`, `assets/brand/google-oauth-logo-120.png`, `assets/brand/dodo-logo-512.png`, `src-tauri/icons/**` | Generated from the source mark by the documented scripts in `scripts/brand/`; commits `1ae5528`, `27191aa`, and `b8fca03`. The Google- and Dodo-named files contain the Kairo mark for upload to those services, not vendor artwork. | **Conditional:** transformation provenance is documented, but reuse depends on resolving ownership of the original Kairo mark above. |
| `src/assets/onboarding/blender-viewport.webp` | Byte-identical to `prasad-178/kairo/public/hero/blender-viewport.webp` (SHA-256 `e41c949c212615e50818c9635ed8e6891880b980802599b487de50df73707976`); imported in commit `1f04d15`. Neither repository records who captured it or the depicted project source. | **Unresolved:** confirm and record that the team created and owns the screenshot and depicted work, or replace it with a newly captured, documented asset. |
| `src/assets/sounds/bubble-pop.wav`, `echo-pop.wav`, `error-blip.wav`, `toing-loud.wav` | Same-named MP3 files were added in commit `78caaae` and transcoded to WAV in `6b7dec8`. The files contain FFmpeg encoder metadata but no creator, source URL, or license. | **Unresolved:** obtain source and license records or replace with newly created/generated sounds whose rights are documented. |
| `src/onboarding/audio/*.wav` | Generated as cached speech with Sarvam TTS; commit `b66e408` and `scripts/gen-onboarding-audio.ts` document the generation path. Later commits regenerated individual lines. [Sarvam's Terms of Service](https://www.sarvam.ai/terms-of-service), section 3.4, stated that customers own service output when reviewed on 2026-07-31. | **Known generation path:** retain the relevant Sarvam account/terms record, input copy, speaker/model, and generation date in maintainer records. Provider terms can change and are not a substitute for that evidence. |
| `src/notch/audio/upgrade.wav` | Cached speech introduced in commit `c098203`; repository documentation identifies the same Sarvam TTS generation workflow. | **Known generation path:** retain the same provider/account/output evidence described above. |

## Adding or replacing assets

For every new binary asset, record:

- the exact repository path and a SHA-256 digest;
- the creator and rightsholder;
- whether it is original, generated, licensed, or adapted;
- the source URL, license version, permission receipt, or generation record;
- all derived files produced from it.

Do not label an asset MIT-licensed until the rightsholder has actually granted that license. Product
and company logos may also carry trademark restrictions independent of copyright.
