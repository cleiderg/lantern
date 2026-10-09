-- Snapshot columns for rate-spike detection.
-- Recorded at suppression time; compared against current totals to detect a 10× rate jump.
ALTER TABLE observations ADD COLUMN occurrences_at_suppress INTEGER;
ALTER TABLE observations ADD COLUMN pulse_count_at_suppress INTEGER;
