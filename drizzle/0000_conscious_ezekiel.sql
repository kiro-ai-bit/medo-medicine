CREATE TABLE "medicine_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_name" text NOT NULL,
	"ingredient_names" text[] NOT NULL,
	"form" text NOT NULL,
	"packaging_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_brand_name_len" CHECK (length("medicine_catalog_entries"."brand_name") BETWEEN 1 AND 200),
	CONSTRAINT "catalog_ingredients_min" CHECK (cardinality("medicine_catalog_entries"."ingredient_names") >= 1),
	CONSTRAINT "catalog_form_enum" CHECK ("medicine_catalog_entries"."form" IN ('tablet','capsule','syrup','injection','drops','other')),
	CONSTRAINT "catalog_pack_qty" CHECK ("medicine_catalog_entries"."packaging_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_photo_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"photo_key" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "catalog_photo_keys_slot_enum" CHECK ("catalog_photo_keys"."slot" IN ('A','B','C'))
);
--> statement-breakpoint
CREATE TABLE "catalog_photos" (
	"entry_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"photo_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_photos_entry_id_slot_pk" PRIMARY KEY("entry_id","slot"),
	CONSTRAINT "catalog_photos_slot_enum" CHECK ("catalog_photos"."slot" IN ('A','B','C'))
);
--> statement-breakpoint
CREATE TABLE "consumer_offsets" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dose_outcome_states" (
	"medicine_id" uuid NOT NULL,
	"dose_id" uuid NOT NULL,
	"last_outcome" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dose_outcome_states_medicine_id_dose_id_pk" PRIMARY KEY("medicine_id","dose_id"),
	CONSTRAINT "dose_outcome_states_outcome_enum" CHECK ("dose_outcome_states"."last_outcome" IN ('taken-on-time','taken-late','skipped','missed'))
);
--> statement-breakpoint
CREATE TABLE "patient_medicines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"catalog_entry_id" uuid NOT NULL,
	"prescribing_doctor" text NOT NULL,
	"dosage" text NOT NULL,
	"doses_remaining" integer NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"pharmacy_name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"refill_low_armed" boolean DEFAULT true NOT NULL,
	"refill_out_armed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_medicines_doctor_len" CHECK (length("patient_medicines"."prescribing_doctor") BETWEEN 1 AND 200),
	CONSTRAINT "patient_medicines_dosage_len" CHECK (length("patient_medicines"."dosage") BETWEEN 1 AND 200),
	CONSTRAINT "patient_medicines_doses_remaining" CHECK ("patient_medicines"."doses_remaining" >= 0),
	CONSTRAINT "patient_medicines_price" CHECK ("patient_medicines"."price" >= 0),
	CONSTRAINT "patient_medicines_pharmacy_len" CHECK (length("patient_medicines"."pharmacy_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "catalog_photo_keys" ADD CONSTRAINT "catalog_photo_keys_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."medicine_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_photos" ADD CONSTRAINT "catalog_photos_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."medicine_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_outcome_states" ADD CONSTRAINT "dose_outcome_states_medicine_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."patient_medicines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_medicines" ADD CONSTRAINT "patient_medicines_catalog_entry_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."medicine_catalog_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_catalog_brand_form" ON "medicine_catalog_entries" USING btree ("brand_name","form");--> statement-breakpoint
CREATE INDEX "idx_catalog_updated" ON "medicine_catalog_entries" USING btree ("updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_catalog_entries_identity" ON "medicine_catalog_entries" USING btree ("brand_name","form","ingredient_names");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_photo_keys_photo_key_key" ON "catalog_photo_keys" USING btree ("photo_key");--> statement-breakpoint
CREATE INDEX "idx_photo_keys_entry_slot" ON "catalog_photo_keys" USING btree ("entry_id","slot");--> statement-breakpoint
CREATE INDEX "idx_photo_keys_unconfirmed" ON "catalog_photo_keys" USING btree ("confirmed_at") WHERE "catalog_photo_keys"."confirmed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_patient_medicines_patient" ON "patient_medicines" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_patient_medicines_catalog" ON "patient_medicines" USING btree ("catalog_entry_id");