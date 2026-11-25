// The machine Tabellar runs on, which is not always the one the window is open
// on. The server says (GET /session).
export type Host = { mac: boolean; headless: boolean; keychain: boolean };

export const host: Host = { mac: true, headless: false, keychain: true };

export const machine = () => (host.mac ? "Mac" : "server");
export const here = () => `this ${machine()}`;
export const vault = () => (host.keychain ? "the macOS Keychain" : `an encrypted file on ${here()}`);
