// The machine Tabellar runs on, which is not always the one the window is open
// on. The server says (GET /session). Hosted is a Tabellar+ server, reached by a
// public name.
export type Host = { mac: boolean; headless: boolean; keychain: boolean; hosted: boolean };

export const host: Host = { mac: true, headless: false, keychain: true, hosted: false };

export const machine = () => (host.mac ? "Mac" : "server");
export const here = () => `this ${machine()}`;
export const vault = () => (host.keychain ? "the macOS Keychain" : `an encrypted file on ${here()}`);
