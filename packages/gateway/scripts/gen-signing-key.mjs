// Generates the gateway's ECDSA P-256 identity signing key.
//   node packages/gateway/scripts/gen-signing-key.mjs [kid]
// Prints the private JWK to feed `wrangler secret put IDENTITY_SIGNING_PRIVATE_JWK`, and the
// public JWK apps verify against.

const kid = process.argv[2] ?? 'k1';
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const priv = await crypto.subtle.exportKey('jwk', privateKey);
const pub = await crypto.subtle.exportKey('jwk', publicKey);

console.log('IDENTITY_SIGNING_PRIVATE_JWK (private, keep secret):');
console.log(JSON.stringify({ ...priv, kid }));
console.log('\npublic JWK (kid=' + kid + ', publish to apps / JWKS):');
console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid, use: 'sig', alg: 'ES256' }));
