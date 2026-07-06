CREATE TYPE "public"."currency" AS ENUM('USD', 'KRW');--> statement-breakpoint
CREATE TYPE "public"."market" AS ENUM('US', 'KR');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'filled', 'cancelled', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('market', 'limit');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('active', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"season_id" text NOT NULL,
	"cash_krw" numeric(18, 2) NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_user_id_season_id_pk" PRIMARY KEY("user_id","season_id"),
	CONSTRAINT "cash_krw_non_negative" CHECK ("accounts"."cash_krw" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"pair" text PRIMARY KEY NOT NULL,
	"rate" numeric(12, 4) NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"currency" "currency" NOT NULL,
	"prev_close" numeric(18, 2),
	"prev_close_date" date,
	"last_price" numeric(18, 2),
	"last_price_at" timestamp with time zone,
	CONSTRAINT "instruments_market_symbol_pk" PRIMARY KEY("market","symbol")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"season_id" text NOT NULL,
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"side" "side" NOT NULL,
	"type" "order_type" NOT NULL,
	"qty" numeric(20, 6) NOT NULL,
	"limit_price" numeric(18, 2),
	"filled_price" numeric(18, 2),
	"fx_rate" numeric(12, 4),
	"reserved_krw" numeric(18, 2),
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"user_id" text NOT NULL,
	"season_id" text NOT NULL,
	"date" date NOT NULL,
	"total_value_krw" numeric(18, 2) NOT NULL,
	CONSTRAINT "portfolio_snapshots_user_id_season_id_date_pk" PRIMARY KEY("user_id","season_id","date")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"user_id" text NOT NULL,
	"season_id" text NOT NULL,
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"qty" numeric(20, 6) NOT NULL,
	"cost_basis_krw" numeric(18, 2) NOT NULL,
	"realized_pnl" numeric(18, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "positions_user_id_season_id_market_symbol_pk" PRIMARY KEY("user_id","season_id","market","symbol"),
	CONSTRAINT "qty_non_negative" CHECK ("positions"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "replay_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"scenario_id" text NOT NULL,
	"return_pct" numeric(8, 2),
	"mdd" numeric(8, 2),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "season_results" (
	"season_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rank" integer NOT NULL,
	"return_pct" numeric(8, 2) NOT NULL,
	"mdd" numeric(8, 2) NOT NULL,
	"final_value" numeric(18, 2) NOT NULL,
	CONSTRAINT "season_results_season_id_user_id_pk" PRIMARY KEY("season_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"seed_money" numeric(18, 2) NOT NULL,
	"status" "season_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"image" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"user_id" text NOT NULL,
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_user_id_market_symbol_pk" PRIMARY KEY("user_id","market","symbol")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD CONSTRAINT "replay_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_idempotency_uq" ON "orders" USING btree ("user_id","idempotency_key");