-- Pricing is separate from model configuration. No historical calls are repriced.
CREATE TABLE billing_prices (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 model text NOT NULL, input_microusd bigint NOT NULL CHECK(input_microusd>=0),
 output_microusd bigint NOT NULL CHECK(output_microusd>=0),
 sale_input_microusd bigint NOT NULL CHECK(sale_input_microusd>=0),
 sale_output_microusd bigint NOT NULL CHECK(sale_output_microusd>=0),
 reference text NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_price_latest ON billing_prices(tenant_id,model,created_at DESC);
CREATE TABLE billing_limits (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), enabled boolean NOT NULL DEFAULT false,
 daily_microusd bigint NOT NULL CHECK(daily_microusd>=0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_task_limits (
 tenant_id uuid NOT NULL REFERENCES tenants(id), task_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 amount_microusd bigint NOT NULL CHECK(amount_microusd>=0), enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,task_id)
);
CREATE TABLE billing_calls (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid REFERENCES users(id),
 task_id text, step text NOT NULL, department text NOT NULL, model text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('text','search','image','video','audio','tool')),
 day date NOT NULL, price_id uuid REFERENCES billing_prices(id),
 reserved_microusd bigint NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0),
 cost_microusd bigint, sale_microusd bigint, input_tokens bigint, output_tokens bigint,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','rejected','unknown')),
 provider_request_id text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK(cost_microusd IS NULL OR cost_microusd>=0), CHECK(sale_microusd IS NULL OR sale_microusd>=0)
);
CREATE INDEX billing_calls_tenant_day ON billing_calls(tenant_id,day,created_at DESC,id);
CREATE TABLE billing_reviews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), call_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), upstream_microusd bigint NOT NULL CHECK(upstream_microusd>=0),
 reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,call_id)
);
-- A local simulator, deliberately separate from subscriptions, real funds and live usage.
CREATE TABLE billing_test_orders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL, amount_microusd bigint NOT NULL CHECK(amount_microusd>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid','refunded')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,user_id,request_id)
);
CREATE TABLE billing_test_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL REFERENCES billing_test_orders(id),
 event text NOT NULL CHECK(event IN ('paid','refunded')), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,event)
);
ALTER TABLE billing_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_prices_tenant ON billing_prices USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_limits_tenant ON billing_limits USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_task_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_task_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_task_limits_tenant ON billing_task_limits USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_calls_tenant ON billing_calls USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_reviews_tenant ON billing_reviews USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_test_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_test_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_test_orders_tenant ON billing_test_orders USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE billing_test_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_test_events FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_test_events_tenant ON billing_test_events USING(tenant_id::text=current_setting('app.tenant_id',true));
