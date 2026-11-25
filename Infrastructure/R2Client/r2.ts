import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Thrown when R2 is unreachable — callers map to 503 DEPENDENCY_UNAVAILABLE.
export class R2UnavailableError extends Error {
  constructor(message = "r2 unavailable") {
    super(message);
    this.name = "R2UnavailableError";
  }
}

export const PHOTO_PRESIGN_TTL_SECONDS = 900;
const VERIFY_TIMEOUT_MS = 10_000;
const VERIFY_RETRIES = 2;
const RETRY_DELAY_MS = 200;

export interface R2Client {
  createPresignedPut(photoKey: string): Promise<{
    url: string;
    expiresAt: Date;
  }>;
  verifyObjectExists(photoKey: string): Promise<boolean>;
  publicPhotoUrl(photoKey: string): string;
}

export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
}

export function createR2Client(config: R2Config): R2Client {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const base = config.publicBaseUrl.replace(/\/+$/, "");

  return {
    async createPresignedPut(photoKey: string) {
      const command = new PutObjectCommand({
        Bucket: config.bucketName,
        Key: photoKey,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: PHOTO_PRESIGN_TTL_SECONDS,
      });
      return {
        url,
        expiresAt: new Date(Date.now() + PHOTO_PRESIGN_TTL_SECONDS * 1000),
      };
    },

    async verifyObjectExists(photoKey: string): Promise<boolean> {
      for (let attempt = 0; attempt <= VERIFY_RETRIES; attempt++) {
        try {
          await client.send(
            new HeadObjectCommand({
              Bucket: config.bucketName,
              Key: photoKey,
            }),
            { abortSignal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
          );
          return true;
        } catch (err) {
          const status = (err as { $metadata?: { httpStatusCode?: number } })
            .$metadata?.httpStatusCode;
          const name = (err as { name?: string }).name;
          if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
            return false;
          }
          if (attempt < VERIFY_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          throw new R2UnavailableError("r2 verify unavailable");
        }
      }
      throw new R2UnavailableError("r2 verify unavailable");
    },

    publicPhotoUrl(photoKey: string): string {
      return `${base}/${photoKey}`;
    },
  };
}
