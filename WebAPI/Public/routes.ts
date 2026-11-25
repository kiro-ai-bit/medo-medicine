import type { FastifyInstance } from "fastify";
import {
  CatalogEntryDtoSchema,
  CatalogEntryIdParamsSchema,
  CatalogListResponseSchema,
  CatalogQuerySchema,
  ConfirmPhotoParamsSchema,
  ConfirmPhotoRequestSchema,
  CreateCatalogEntryRequestSchema,
  IssuePhotoRequestSchema,
  IssuePhotoResponseSchema,
  PatchCatalogEntryRequestSchema,
} from "@kiro-ai-bit/contracts";
import {
  confirmPhotoKey,
  createCatalogEntry,
  editCatalogEntry,
  getCatalogEntry,
  issuePhotoKey,
  listCatalog,
  type CatalogDeps,
} from "@core/Catalog/catalog.js";
import { ForbiddenError } from "../Middleware/errors.js";
import type { PhotoSlot } from "@infrastructure/Persistence/schema/index.js";

function requireUser(request: { user?: { sub: string; role: string } }) {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: CatalogDeps,
): void {
  app.get(
    "/v1/medicine-catalog",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        querystring: CatalogQuerySchema,
        response: { 200: CatalogListResponseSchema },
      },
    },
    async (request) => {
      requireUser(request);
      const q = request.query as { q?: string; page?: number };
      return listCatalog(deps, q.q, q.page ?? 1);
    },
  );

  app.get(
    "/v1/medicine-catalog/:id",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        params: CatalogEntryIdParamsSchema,
        response: { 200: CatalogEntryDtoSchema },
      },
    },
    async (request) => {
      requireUser(request);
      const { id } = request.params as { id: string };
      return getCatalogEntry(deps, id);
    },
  );

  app.post(
    "/v1/medicine-catalog",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        body: CreateCatalogEntryRequestSchema,
        response: { 201: CatalogEntryDtoSchema },
      },
    },
    async (request, reply) => {
      requireUser(request);
      const body = request.body as Parameters<typeof createCatalogEntry>[1];
      const result = await createCatalogEntry(deps, body);
      return reply.code(201).send(result);
    },
  );

  app.patch(
    "/v1/medicine-catalog/:id",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: CatalogEntryIdParamsSchema,
        body: PatchCatalogEntryRequestSchema,
        response: { 200: CatalogEntryDtoSchema },
      },
    },
    async (request) => {
      requireUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as Parameters<typeof editCatalogEntry>[2];
      return editCatalogEntry(deps, id, body);
    },
  );

  app.post(
    "/v1/medicine-catalog/:id/photos",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: CatalogEntryIdParamsSchema,
        body: IssuePhotoRequestSchema,
        response: { 200: IssuePhotoResponseSchema },
      },
    },
    async (request) => {
      requireUser(request);
      const { id } = request.params as { id: string };
      const { slot } = request.body as { slot: PhotoSlot };
      return issuePhotoKey(deps, id, slot);
    },
  );

  app.put(
    "/v1/medicine-catalog/:id/photos/:slot",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: ConfirmPhotoParamsSchema,
        body: ConfirmPhotoRequestSchema,
        response: { 200: CatalogEntryDtoSchema },
      },
    },
    async (request) => {
      requireUser(request);
      const { id, slot } = request.params as { id: string; slot: PhotoSlot };
      const { photoKey } = request.body as { photoKey: string };
      return confirmPhotoKey(deps, id, slot, photoKey);
    },
  );
}
