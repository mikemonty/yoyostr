# YoYoStr

Static Nostr-powered web app. Files live in `docs/`.

## Connect a signer

- Extension (NIP-07): click "Login" in the header, then choose "Connect extension" and approve in your NIP-07 extension (Alby, nos2x, etc.).
- Remote signer (NIP-46): on the same screen, scan the QR in a mobile signer (Primal, etc.) and click "I scanned the QR", or paste a `nostrconnect://` / `bunker://` string and connect.

The app stores your active signer and NIP-46 sessions in IndexedDB so you don't have to rescan every time.
