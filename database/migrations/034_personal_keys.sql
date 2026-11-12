CREATE TABLE personal_model_keys (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 encrypted_key text NOT NULL, revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
ALTER TABLE personal_model_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_model_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_keys_private ON personal_model_keys USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE TABLE runtime_identities (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), runtime_user_id text NOT NULL,
 PRIMARY KEY(tenant_id,user_id), UNIQUE(tenant_id,runtime_user_id)
);
ALTER TABLE runtime_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_identities_tenant ON runtime_identities USING(tenant_id::text=current_setting('app.tenant_id',true));
CREATE TABLE personal_provider_assets (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), provider_id text NOT NULL,
 key_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id,provider_id)
);
ALTER TABLE personal_provider_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_provider_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_assets_private ON personal_provider_assets USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
-- Snapshot existing ownership for read-only access to historical shared-runtime tasks.
CREATE TABLE legacy_runtime_tasks (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 runtime_task_id text NOT NULL, PRIMARY KEY(tenant_id,user_id,runtime_task_id)
);
INSERT INTO legacy_runtime_tasks
SELECT tenant_id,user_id,runtime_task_id FROM operations_submissions WHERE runtime_task_id ~ '^[a-f0-9]{24}$'
UNION
SELECT tenant_id,user_id,t->>'runtimeTaskId' FROM secretary_workspaces,
LATERAL jsonb_array_elements(COALESCE(board->'tasks','[]'::jsonb)) t
WHERE t->>'dept'='app-agent' AND t->>'runtimeTaskId' ~ '^[a-f0-9]{24}$'
ON CONFLICT DO NOTHING;
ALTER TABLE legacy_runtime_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_runtime_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_tasks_private ON legacy_runtime_tasks USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
