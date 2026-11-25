// User JWT claims issued by Identity (iss=medo-identity, aud=medo).
export interface UserClaims {
  sub: string;
  role: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
  iss: string;
  aud: string | string[];
}
