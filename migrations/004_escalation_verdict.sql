-- Release approval is an explicit human verdict, not "any answer".
-- NULL = answered without a verdict (or not answered). Existing rows stay NULL,
-- so an answer given before this migration no longer counts as approval.
ALTER TABLE escalations ADD COLUMN verdict TEXT CHECK (verdict IN ('approve','reject'));
