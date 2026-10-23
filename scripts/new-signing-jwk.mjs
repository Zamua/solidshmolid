// Prints a fresh ES256 private JWK for OIDC_SIGNING_JWK.
import { exportJWK, generateKeyPair } from 'jose';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
process.stdout.write(JSON.stringify({ ...(await exportJWK(privateKey)), kid: crypto.randomUUID() }));
