-- Storage primitives for Pydantic AI's ConversationStore (assistant chats).
CREATE TABLE assistant_conversations (
    conversation_id TEXT PRIMARY KEY,
    scope TEXT,
    head_id TEXT,
    branches_json TEXT NOT NULL DEFAULT '[]',
    revision TEXT NOT NULL,
    title TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
);

CREATE INDEX idx_assistant_conversations_scope_updated
    ON assistant_conversations(scope, updated_at DESC);

CREATE TABLE assistant_conversation_entries (
    entry_id TEXT PRIMARY KEY,
    parent_id TEXT,
    entry_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_assistant_conversation_entries_parent
    ON assistant_conversation_entries(parent_id);
