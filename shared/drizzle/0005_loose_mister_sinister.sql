CREATE TABLE "investment_profiles" (
	"user_id" text NOT NULL,
	"season_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"traits" jsonb,
	"model" text,
	"input_hash" text,
	"generation_started_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_profiles_user_id_season_id_pk" PRIMARY KEY("user_id","season_id")
);
--> statement-breakpoint
ALTER TABLE "investment_profiles" ADD CONSTRAINT "investment_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_profiles" ADD CONSTRAINT "investment_profiles_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;