-- Align persisted D1 schema terminology with the canonical model:
-- matches are built from Schelling prompts, not questions.

ALTER TABLE vote_logs RENAME COLUMN question_id TO prompt_id;

ALTER TABLE question_ratings RENAME TO prompt_ratings;
ALTER TABLE prompt_ratings RENAME COLUMN question_id TO prompt_id;
