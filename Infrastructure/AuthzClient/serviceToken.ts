import { importJWK, SignJWT } from "jose";
import type { JWK } from "jose";

const SERVICE_TOKEN_TTL_SEC = 5 * 60;

// Mints outbound service JWTs (iss=medo-medicine, 5-min, aud-scoped per call).
export function createServiceTokenMinter(servicePrivateKeyJwk: JWK) {
  const alg = (servicePrivateKeyJwk.alg as string | undefined) ?? "ES256";
  let privateKey: CryptoKey | null = null;

  return async function mintServiceToken(aud: string): Promise<string> {
    if (!privateKey) {
      privateKey = (await importJWK(servicePrivateKeyJwk, alg)) as CryptoKey;
    }
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: "service" })
      .setProtectedHeader({
        alg,
        kid: servicePrivateKeyJwk.kid,
        typ: "JWT",
      })
      .setIssuer("medo-medicine")
      .setAudience(aud)
      .setSubject("medo-medicine")
      .setIssuedAt(iat)
      .setExpirationTime(iat + SERVICE_TOKEN_TTL_SEC)
      .sign(privateKey);
  };
}
