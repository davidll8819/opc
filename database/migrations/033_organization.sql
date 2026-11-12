CREATE TABLE organization_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 revision integer NOT NULL DEFAULT 1,
 departments jsonb NOT NULL,
 jobs jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON organization_settings USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE employee_duty ADD COLUMN organization_department text;
ALTER TABLE employee_duty ADD COLUMN job_id text;
ALTER TABLE employee_duty ADD COLUMN model_overrides jsonb NOT NULL DEFAULT '{}';
