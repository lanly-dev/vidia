# Change Log

All notable changes to the "vidia" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- NIM add flows now list real containers from the public NGC catalog instead of
  guessing `nvcr.io/nim/<model-id>:latest` from the chat catalog (many guesses,
  e.g. `nim/01-ai/yi-large`, never existed). Entries carry their actual latest
  tag; custom image entry remains as an escape hatch.

- Added a full NVIDIA setup check when the API key is saved: the key is verified
  against the cloud endpoint and probed for NGC pull access (`api.ngc.nvidia.com`).
  The verdict is persisted and drives the tree — the cloud group shows when the key
  is valid, and the NIM group is disabled with guidance when the key is not
  NGC-enabled. New `VIDIA: Re-check NVIDIA Setup` command re-runs the check.

- Initial release
- Added `viewsWelcome` welcome content to the Models Explorer tree view prompting users to set their NVIDIA API key when not configured.
- Added `VIDIA: Clear API Key` command (also a `$(clear-all)` button in the
  Models Explorer title bar) to remove stored NVIDIA/NGC API keys from
  SecretStorage with confirmation.