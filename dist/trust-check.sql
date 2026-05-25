-- trust-check.sql
-- Generated from schema.json by scripts/generate-enums.js — do not edit manually.
--
-- Source-include this snippet in D1 migration files to keep the CHECK constraint
-- on the workers table in sync with the canonical trust enum in schema.json:
--
--   .read dist/trust-check.sql
--
-- Or copy the CHECK(...) expression below directly into your CREATE / ALTER TABLE.

-- Trust levels: Trusted, Verified, Community, Review, Core
CHECK(trust IN ('Trusted', 'Verified', 'Community', 'Review', 'Core'))
