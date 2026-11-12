CREATE TABLE custom_employees (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id text NOT NULL,
 name text NOT NULL, avatar_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
ALTER TABLE custom_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_employees FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_employees_scope ON custom_employees USING(tenant_id::text=current_setting('app.tenant_id',true));
