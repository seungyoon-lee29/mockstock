-- CLEAN CUTOVER: 컬럼 DROP+ADD = 기존 데이터 폐기(E1 런북). 출시 전 개발 DB라 허용.
ALTER TABLE "seasons" ADD COLUMN "market" "market" NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "cash_krw_non_negative";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "cash_krw";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cash" numeric(18, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "cash_non_negative" CHECK ("accounts"."cash" >= 0);--> statement-breakpoint
ALTER TABLE "positions" DROP COLUMN "cost_basis_krw";--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "cost_basis" numeric(18, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "fx_rate";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "reserved_krw";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reserved" numeric(18, 2);--> statement-breakpoint
DROP INDEX "orders_user_idempotency_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_season_idempotency_uq" ON "orders" USING btree ("user_id","season_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" DROP COLUMN "total_value_krw";--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD COLUMN "total_value" numeric(18, 2) NOT NULL;--> statement-breakpoint
DROP TABLE "fx_rates";
