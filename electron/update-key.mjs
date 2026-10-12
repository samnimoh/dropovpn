// Public half of the release signing key. Each release's SHA256SUMS.txt is signed
// in CI with the private half (the UPDATE_SIGNING_KEY secret), and the app only
// installs an update whose checksums carry a valid signature from this key.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3TpcjJBzuRtfGN9pn3p/zVEKoSpaphTWiTYW+GrCm4o=
-----END PUBLIC KEY-----`;
