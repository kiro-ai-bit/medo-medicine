import type { FastifyInstance } from "fastify";
import {
  ArchiveMedicineResponseSchema,
  CreateMedicineRequestSchema,
  DeleteMedicineResponseSchema,
  ListMedicinesQuerySchema,
  ListMedicinesResponseSchema,
  MedicineIdParamsSchema,
  PatientMedicineDetailDtoSchema,
  PatchMedicineRequestSchema,
} from "@kiro-ai-bit/contracts";
import {
  archiveMedicine,
  createMedicine,
  deleteMedicine,
  editMedicine,
  getMedicine,
  listMedicines,
  type MedicineDeps,
} from "@core/Medicine/medicine.js";
import { ForbiddenError } from "../Middleware/errors.js";
import type { UserClaims } from "@core/types.js";

function requireUser(request: { user?: UserClaims }) {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

export function registerMedicineRoutes(
  app: FastifyInstance,
  deps: MedicineDeps,
): void {
  app.get(
    "/v1/medicines",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        querystring: ListMedicinesQuerySchema,
        response: { 200: ListMedicinesResponseSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { patientId } = request.query as { patientId: string };
      return listMedicines(deps, patientId, user);
    },
  );

  app.post(
    "/v1/medicines",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        body: CreateMedicineRequestSchema,
        response: { 201: PatientMedicineDetailDtoSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as Parameters<typeof createMedicine>[1];
      const result = await createMedicine(deps, body, user);
      return reply.code(201).send(result);
    },
  );

  app.get(
    "/v1/medicines/:id",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        params: MedicineIdParamsSchema,
        response: { 200: PatientMedicineDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return getMedicine(deps, id, user);
    },
  );

  app.patch(
    "/v1/medicines/:id",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: MedicineIdParamsSchema,
        body: PatchMedicineRequestSchema,
        response: { 200: PatientMedicineDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as Parameters<typeof editMedicine>[2];
      return editMedicine(deps, id, body, user);
    },
  );

  app.post(
    "/v1/medicines/:id/archive",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: MedicineIdParamsSchema,
        response: { 200: ArchiveMedicineResponseSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return archiveMedicine(deps, id, user);
    },
  );

  app.delete(
    "/v1/medicines/:id",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: MedicineIdParamsSchema,
        response: { 200: DeleteMedicineResponseSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return deleteMedicine(deps, id, user);
    },
  );
}
