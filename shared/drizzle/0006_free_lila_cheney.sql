CREATE TABLE "daily_candles" (
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"o" numeric(18, 2) NOT NULL,
	"h" numeric(18, 2) NOT NULL,
	"l" numeric(18, 2) NOT NULL,
	"c" numeric(18, 2) NOT NULL,
	"v" numeric(20, 0) NOT NULL,
	CONSTRAINT "daily_candles_market_symbol_date_pk" PRIMARY KEY("market","symbol","date")
);
