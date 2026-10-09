-- Add a pid column to sessions so `lantern kill` can send SIGTERM from a separate process.
ALTER TABLE sessions ADD COLUMN pid INTEGER;
