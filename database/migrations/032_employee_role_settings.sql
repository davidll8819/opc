-- Extend the already authorized employee table; retain seat, identity and bindings.
ALTER TABLE employee_duty
 ADD COLUMN job_title text CHECK(length(job_title) BETWEEN 1 AND 60),
 ADD COLUMN capabilities text CHECK(length(capabilities) BETWEEN 1 AND 4000),
 ADD COLUMN profile_revision integer NOT NULL DEFAULT 0 CHECK(profile_revision>=0);
