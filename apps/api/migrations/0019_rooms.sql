-- 0019_rooms: W8-D (docs/plan/wave-8.md "W8-D"; spec "Profiles, leaderboards and rooms" › Rooms,
-- "Identity and personhood" › Account deletion).
--
-- rooms.closed_at: when the room closed. A room closes when its owner deletes their account and no
-- other member remains (decision B5, Oct 12, 2026); a closed room takes no joins and gets no new room
-- rounds, and its unlocked room rounds close without a round.
ALTER TABLE rooms ADD COLUMN closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= 0);

-- questions.room_id: a room's custom question (POST /rooms/:id/questions), moderated like any other
-- but private to the room: it never enters the public vote queue, lists, boards or duplicate index.
ALTER TABLE questions ADD COLUMN room_id TEXT;
CREATE INDEX questions_room_idx ON questions (room_id, created_at) WHERE room_id IS NOT NULL;

-- One room round per room per daily slot (the scheduler inserts them ahead, like daily rounds).
CREATE UNIQUE INDEX rounds_room_slot ON rounds (room_id, closes_at) WHERE kind = 'room';
