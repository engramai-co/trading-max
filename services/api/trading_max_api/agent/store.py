"""SQLite storage primitives for Pydantic AI's conversation store.

Pydantic AI owns the conversation logic: which messages are new, branching on
regenerate or edit, revision conflicts and scope checks. This module only
implements the five primitives its `ConversationStore` asks a backend for.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime

from pydantic import TypeAdapter
from pydantic_ai.conversation_store import (
    ConversationConflict,
    ConversationEntry,
    ConversationRecord,
    ConversationStore,
)
from pydantic_ai.messages import ModelRequest, UserPromptPart
from trading_max.infrastructure import SqliteDatabase

_RECORD = TypeAdapter(ConversationRecord)
_ENTRY = TypeAdapter(ConversationEntry)
TITLE_LIMIT = 80

_PRUNE_UNREACHABLE = """
WITH RECURSIVE
roots(entry_id) AS (
    SELECT head_id FROM assistant_conversations WHERE head_id IS NOT NULL
    UNION
    SELECT value FROM assistant_conversations, json_each(assistant_conversations.branches_json)
),
reachable(entry_id) AS (
    SELECT entry_id FROM roots
    UNION
    SELECT entries.parent_id
    FROM assistant_conversation_entries AS entries
    JOIN reachable ON entries.entry_id = reachable.entry_id
    WHERE entries.parent_id IS NOT NULL
)
DELETE FROM assistant_conversation_entries
WHERE entry_id NOT IN (SELECT entry_id FROM reachable)
"""

_HISTORY = """
WITH RECURSIVE chain(entry_id, parent_id, entry_json, depth) AS (
    SELECT entry_id, parent_id, entry_json, 0
    FROM assistant_conversation_entries WHERE entry_id = ?
    UNION ALL
    SELECT entries.entry_id, entries.parent_id, entries.entry_json, chain.depth + 1
    FROM assistant_conversation_entries AS entries
    JOIN chain ON entries.entry_id = chain.parent_id
    WHERE ? IS NULL OR chain.depth + 1 < ?
)
SELECT parent_id, entry_json FROM chain ORDER BY depth DESC
"""


def _title(entries: Sequence[ConversationEntry]) -> str | None:
    """The first user prompt, collapsed to one line, for conversation lists."""

    for entry in entries:
        if not isinstance(entry.message, ModelRequest):
            continue
        for part in entry.message.parts:
            if not isinstance(part, UserPromptPart):
                continue
            content = part.content
            text = (
                content
                if isinstance(content, str)
                else " ".join(item for item in content if isinstance(item, str))
            )
            text = " ".join(text.split())
            if text:
                return text[:TITLE_LIMIT]
    return None


def _timestamp(value: datetime) -> str:
    moment = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat(timespec="microseconds")


class SqliteConversationStore(ConversationStore):
    """Keep assistant conversations in the workspace database.

    Deleting a conversation also deletes the messages no other conversation
    still reaches, so a deleted chat leaves nothing behind in this database.
    """

    def __init__(self, database: SqliteDatabase) -> None:
        self._database = database

    async def read_record(self, conversation_id: str) -> ConversationRecord | None:
        return await asyncio.to_thread(self._db_read_record, conversation_id)

    async def read_records(
        self, *, scope: str | None = None, limit: int | None = None
    ) -> Sequence[ConversationRecord]:
        return await asyncio.to_thread(self._db_read_records, scope, limit)

    async def write_record(
        self,
        record: ConversationRecord,
        *,
        new_entries: Sequence[ConversationEntry] = (),
        expected_revision: str | None,
    ) -> None:
        await asyncio.to_thread(
            self._db_write_record, record, tuple(new_entries), expected_revision
        )

    async def delete_record(self, conversation_id: str, *, expected_revision: str) -> None:
        await asyncio.to_thread(self._db_delete_record, conversation_id, expected_revision)

    async def read_entry(self, entry_id: str) -> ConversationEntry:
        return await asyncio.to_thread(self._db_read_entry, entry_id)

    async def read_history(
        self, head_id: str | None, *, limit: int | None = None
    ) -> list[ConversationEntry]:
        if head_id is None or (limit is not None and limit <= 0):
            return []
        return await asyncio.to_thread(self._db_read_history, head_id, limit)

    async def titles(self, conversation_ids: Sequence[str]) -> dict[str, str | None]:
        """Stored list titles; conversation records have no title of their own."""

        return await asyncio.to_thread(self._db_titles, tuple(conversation_ids))

    def _db_read_record(self, conversation_id: str) -> ConversationRecord | None:
        with self._database.read() as connection:
            row = connection.execute(
                "SELECT record_json FROM assistant_conversations WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return None if row is None else _RECORD.validate_json(row["record_json"])

    def _db_read_records(self, scope: str | None, limit: int | None) -> list[ConversationRecord]:
        query = "SELECT record_json FROM assistant_conversations"
        parameters: list[object] = []
        if scope is not None:
            query += " WHERE scope = ?"
            parameters.append(scope)
        query += " ORDER BY updated_at DESC, conversation_id DESC"
        if limit is not None:
            query += " LIMIT ?"
            parameters.append(max(0, limit))
        with self._database.read() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [_RECORD.validate_json(row["record_json"]) for row in rows]

    def _db_titles(self, conversation_ids: tuple[str, ...]) -> dict[str, str | None]:
        if not conversation_ids:
            return {}
        with self._database.read() as connection:
            rows = connection.execute(
                "SELECT conversation_id, title FROM assistant_conversations "
                "WHERE conversation_id IN (SELECT value FROM json_each(?))",
                (json.dumps(list(conversation_ids)),),
            ).fetchall()
        return {row["conversation_id"]: row["title"] for row in rows}

    def _db_write_record(
        self,
        record: ConversationRecord,
        new_entries: tuple[ConversationEntry, ...],
        expected_revision: str | None,
    ) -> None:
        now = _timestamp(datetime.now(UTC))
        with self._database.transaction(immediate=True) as connection:
            stored = connection.execute(
                "SELECT revision, title FROM assistant_conversations WHERE conversation_id = ?",
                (record.conversation_id,),
            ).fetchone()
            if (stored["revision"] if stored is not None else None) != expected_revision:
                raise ConversationConflict(record.conversation_id)
            new_ids = {entry.id for entry in new_entries}
            if record.head_id is not None and record.head_id not in new_ids:
                exists = connection.execute(
                    "SELECT 1 FROM assistant_conversation_entries WHERE entry_id = ?",
                    (record.head_id,),
                ).fetchone()
                if exists is None:
                    raise ConversationConflict(record.conversation_id)
            connection.executemany(
                "INSERT OR IGNORE INTO assistant_conversation_entries "
                "(entry_id, parent_id, entry_json, created_at) VALUES (?, ?, ?, ?)",
                [
                    (entry.id, entry.parent_id, _ENTRY.dump_json(entry).decode(), now)
                    for entry in new_entries
                ],
            )
            title = stored["title"] if stored is not None and stored["title"] else None
            if title is None:
                title = _title(new_entries)
            connection.execute(
                "INSERT INTO assistant_conversations "
                "(conversation_id, scope, head_id, branches_json, revision, title, "
                "updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(conversation_id) DO UPDATE SET scope = excluded.scope, "
                "head_id = excluded.head_id, branches_json = excluded.branches_json, "
                "revision = excluded.revision, title = excluded.title, "
                "updated_at = excluded.updated_at, record_json = excluded.record_json",
                (
                    record.conversation_id,
                    record.scope,
                    record.head_id,
                    json.dumps(list(record.branches)),
                    record.revision,
                    title,
                    _timestamp(record.updated_at),
                    _RECORD.dump_json(record).decode(),
                ),
            )

    def _db_delete_record(self, conversation_id: str, expected_revision: str) -> None:
        with self._database.transaction(immediate=True) as connection:
            deleted = connection.execute(
                "DELETE FROM assistant_conversations WHERE conversation_id = ? AND revision = ?",
                (conversation_id, expected_revision),
            ).rowcount
            if deleted != 1:
                raise ConversationConflict(conversation_id)
            connection.execute(_PRUNE_UNREACHABLE)

    def _db_read_entry(self, entry_id: str) -> ConversationEntry:
        with self._database.read() as connection:
            row = connection.execute(
                "SELECT entry_json FROM assistant_conversation_entries WHERE entry_id = ?",
                (entry_id,),
            ).fetchone()
        if row is None:
            raise KeyError(entry_id)
        return _ENTRY.validate_json(row["entry_json"])

    def _db_read_history(self, head_id: str, limit: int | None) -> list[ConversationEntry]:
        with self._database.read() as connection:
            rows = connection.execute(_HISTORY, (head_id, limit, limit)).fetchall()
        if not rows:
            raise KeyError(head_id)
        if (limit is None or len(rows) < limit) and rows[0]["parent_id"] is not None:
            # The chain stopped at an entry whose parent is gone: report it as missing,
            # exactly as one read_entry() call per entry would.
            raise KeyError(rows[0]["parent_id"])
        return [_ENTRY.validate_json(row["entry_json"]) for row in rows]


__all__ = ["SqliteConversationStore"]
